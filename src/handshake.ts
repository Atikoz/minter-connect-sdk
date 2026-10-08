/**
 * Незалежна перевірка handshake на боці DEX.
 *
 * Навіщо: без неї SDK бере walletAddress і walletPublicKeyHex (ECDH-ключ
 * каналу) на слово relay. Тобто E2E-шифрування не дає нічого проти самого
 * relay — а це головна причина будувати таку схему: хто контролює relay або
 * TLS-термінуючий проксі, підставляє свій ECDH-ключ, читає всі "зашифровані"
 * транзакції, і жодна перевірка адреси цього не помічає.
 *
 * Relay зберігає доказ (identity-ключ + підпис гаманця) і віддає його в
 * GET /sessions/:sessionId саме для цієї перевірки. Перевіряємо два зв'язки:
 *   1) identityPublicKeyHex розгортається РІВНО в заявлену walletAddress;
 *   2) підпис валідний для канонічного повідомлення, у яке входить
 *      ecdhPublicKeyHex — тож підмінений ключ каналу робить підпис невалідним.
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export interface HandshakeClaim {
  sessionId: string;
  walletAddress: string;
  identityPublicKeyHex: string;
  /** ECDH-ключ каналу — той самий walletPublicKeyHex, який віддав relay. */
  ecdhPublicKeyHex: string;
  signature: string;
}

export type HandshakeFailure = 'address_mismatch' | 'invalid_signature';

const MINTER_ADDRESS_RE = /^Mx[0-9a-fA-F]{40}$/;

/**
 * Канонічне повідомлення relay. Hex — завжди в нижньому регістрі: схеми relay
 * приймають будь-який регістр, тож без нормалізації підпис не збігся б з
 * повідомленням, зібраним з того, що relay віддав.
 */
export function handshakeMessage(sessionId: string, ecdhPublicKeyHex: string): string {
  return `minter-connect:handshake:${sessionId}:${ecdhPublicKeyHex.toLowerCase()}`;
}

export function verifyHandshake(claim: HandshakeClaim): HandshakeFailure | null {
  if (!publicKeyMatchesAddress(claim.identityPublicKeyHex, claim.walletAddress)) return 'address_mismatch';

  let valid = false;
  try {
    valid = verifySignature(
      claim.identityPublicKeyHex,
      handshakeMessage(claim.sessionId, claim.ecdhPublicKeyHex),
      claim.signature,
    );
  } catch {
    // Структурно некоректний ввід (не-hex, точка не на кривій) — для нас це
    // така сама відмова, як і невірний підпис.
    valid = false;
  }
  return valid ? null : 'invalid_signature';
}

/**
 * address = last20( keccak256( 64 байти координат БЕЗ префікса 0x04 ) ), з
 * префіксом "Mx" замість "0x". Хеш РІВНО від 64 байт: якщо захешувати всі 65
 * (з 0x04), вийде інша адреса — і жодної помилки при цьому не буде.
 */
export function publicKeyToMinterAddress(publicKeyHex: string): string {
  const raw64 = toRawCoordinates(publicKeyHex);
  return `Mx${secp.etc.bytesToHex(keccak_256(raw64).slice(-20))}`;
}

function publicKeyMatchesAddress(publicKeyHex: string, address: string): boolean {
  try {
    if (!MINTER_ADDRESS_RE.test(address)) return false;
    return publicKeyToMinterAddress(publicKeyHex) === `Mx${address.slice(2).toLowerCase()}`;
  } catch {
    return false;
  }
}

function verifySignature(publicKeyHex: string, message: string, signatureHex: string): boolean {
  // @noble/secp256k1 v3 не тягне хеш сам; verify без цього кидає
  // "hashes.sha256 not set". Присвоєння ідемпотентне й без побічних ефектів
  // для середовища, тому робимо його ліниво, а не на імпорті модуля.
  secp.hashes.sha256 ??= sha256;
  const msgHash = sha256(new TextEncoder().encode(message));
  return secp.verify(secp.etc.hexToBytes(signatureHex), msgHash, secp.etc.hexToBytes(publicKeyHex));
}

/** Приймає ключ у compressed (33), uncompressed (65) або "сирих" координатах (64). */
function toRawCoordinates(publicKeyHex: string): Uint8Array {
  const hex = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('invalid_public_key_hex');

  const bytes = secp.etc.hexToBytes(hex.toLowerCase());
  // Point.fromBytes перевіряє, що точка справді лежить на кривій: без цього
  // 65 нульових байт із префіксом 0x04 "успішно" перетворились би на адресу.
  const forPoint = bytes.length === 64 ? secp.etc.concatBytes(Uint8Array.of(0x04), bytes) : bytes;
  return secp.Point.fromBytes(forPoint).toBytes(false).subarray(1);
}
