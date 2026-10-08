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
 * GET /sessions/:sessionId саме для цієї перевірки. Перевіряємо:
 *   1) підписаний домен — НАШ (з конфігу, не з відповіді relay);
 *   2) підпис не протух і не "з майбутнього";
 *   3) identityPublicKeyHex розгортається РІВНО в заявлену walletAddress;
 *   4) підпис валідний для канонічного повідомлення, у яке входять
 *      ecdhPublicKeyHex і домен — тож підмінений ключ каналу робить підпис
 *      невалідним.
 *
 * Логіка — копія verifyHandshake із minter-backend/src/shared/handshake.ts.
 * Розходження ловить test/relay-compat.test.ts (фіксовані вектори з бекенду).
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
  /** Домен, який гаманець ПІДПИСАВ (host з manifest.url). З відповіді relay — тож лише заявка. */
  domain: string;
  /** Unix-час підпису в мілісекундах. */
  issuedAt: number;
  signature: string;
}

export interface HandshakeExpectations {
  /** ВЛАСНИЙ домен сайту з конфігу. Ніколи не значення з відповіді relay. */
  expectedDomain: string;
  /**
   * Наскільки старим може бути підпис на момент перевірки. `Infinity` —
   * свіжість не перевіряється (відновлення сесії, якій може бути до 7 днів);
   * підпис "з майбутнього" понад розбіг годинників відхиляється завжди.
   */
  maxAgeMs: number;
  now?: number;
}

export type HandshakeFailure = 'domain_mismatch' | 'stale_proof' | 'address_mismatch' | 'invalid_signature';

/** Допустимий розбіг годинників гаманця і сайту — те саме PROOF_MAX_AGE_MS, що в relay. */
export const PROOF_MAX_CLOCK_SKEW_MS = 120_000;

const MINTER_ADDRESS_RE = /^Mx[0-9a-fA-F]{40}$/;

/**
 * Домен у підписі — `URL.host`: нижній регістр, порт лише нестандартний.
 * Нормалізація та сама, що в relay (`normalizeDomain`), інакше `App.Example`
 * і `app.example` давали б різні рядки підпису.
 */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Канонічне повідомлення relay (`canonicalMessage.handshake`). Hex — завжди в
 * нижньому регістрі: схеми relay приймають будь-який регістр, тож без
 * нормалізації підпис не збігся б з повідомленням, зібраним з того, що relay
 * віддав.
 */
export function handshakeMessage(sessionId: string, ecdhPublicKeyHex: string, domain: string, issuedAt: number): string {
  return `minter-connect:handshake:${sessionId}:${ecdhPublicKeyHex.toLowerCase()}:${normalizeDomain(domain)}:${issuedAt}`;
}

/**
 * Порядок перевірок — як у relay: домен, свіжість, адреса, підпис.
 * Домен у підписі — аналог `ton_proof`: підпис, який гаманець дав
 * фішинговому сайту, тут не пройде, бо expectedDomain інший.
 */
export function verifyHandshake(claim: HandshakeClaim, expect: HandshakeExpectations): HandshakeFailure | null {
  if (normalizeDomain(claim.domain) !== normalizeDomain(expect.expectedDomain)) return 'domain_mismatch';

  const now = expect.now ?? Date.now();
  if (!Number.isSafeInteger(claim.issuedAt)) return 'stale_proof';
  // Майбутнє — лише в межах розбігу годинників, інакше підпис "з запасом"
  // жив би скільки завгодно.
  if (now - claim.issuedAt > expect.maxAgeMs || claim.issuedAt - now > PROOF_MAX_CLOCK_SKEW_MS) return 'stale_proof';

  if (!publicKeyMatchesAddress(claim.identityPublicKeyHex, claim.walletAddress)) return 'address_mismatch';

  let valid = false;
  try {
    valid = verifySignature(
      claim.identityPublicKeyHex,
      handshakeMessage(claim.sessionId, claim.ecdhPublicKeyHex, claim.domain, claim.issuedAt),
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
