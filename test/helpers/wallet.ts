/**
 * Симуляція СТОРОНИ ГАМАНЦЯ — тільки для тестів.
 *
 * Тут живуть signMessage/verifyMessage та виведення Mx-адреси: у рантаймі SDK
 * вони не потрібні жодного разу (DEX ніколи не підписує handshake — це робить
 * гаманець), тож у dist/ їм не місце.
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// @noble/secp256k1 v3 не тягне хеші сам — sign/verify без цієї прошивки
// падають з "hashes.sha256 not set". Для ECDH (getSharedSecret) вона не
// потрібна, тому в src/crypto.ts її свідомо немає.
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key: Uint8Array, ...msgs: Uint8Array[]) => hmac(sha256, key, secp.etc.concatBytes(...msgs));

export function signMessage(secretKey: Uint8Array, message: string): string {
  const msgHash = sha256(new TextEncoder().encode(message));
  return secp.etc.bytesToHex(secp.sign(msgHash, secretKey));
}

export function verifyMessage(publicKeyHex: string, message: string, signatureHex: string): boolean {
  const msgHash = sha256(new TextEncoder().encode(message));
  return secp.verify(secp.etc.hexToBytes(signatureHex), msgHash, secp.etc.hexToBytes(publicKeyHex));
}

/**
 * Mx-адреса з публічного ключа. Та сама схема, що в Ethereum:
 *   address = last20( keccak256( 64 байти координат БЕЗ префікса 0x04 ) )
 *
 * Саме тут колись був реальний баг: якщо захешувати всі 65 байт (разом із
 * 0x04) або передати в secp.verify 64-байтний ключ без префікса, помилки не
 * буде — verify просто поверне false, і збій виглядатиме як "користувач
 * підписав неправильно". Тому координати дістаються через Point.fromBytes.
 */
export function publicKeyToMinterAddress(publicKeyHex: string): string {
  const bytes = secp.etc.hexToBytes(publicKeyHex.replace(/^0x/, ''));
  // 64 байти "сирих" координат — це те, що віддає minterjs-wallet.getPublicKey();
  // Point.fromBytes без префікса 0x04 кидає "bad point: not on curve".
  const forPoint = bytes.length === 64 ? secp.etc.concatBytes(Uint8Array.of(0x04), bytes) : bytes;
  const raw64 = secp.Point.fromBytes(forPoint).toBytes(false).subarray(1);
  return `Mx${secp.etc.bytesToHex(keccak_256(raw64).slice(-20))}`;
}

export interface SimulatedWallet {
  /** Ключ, яким гаманець доводить володіння адресою (handshake, revoke). */
  identity: { secretKey: Uint8Array; publicKeyHex: string };
  /** Окремий ephemeral-ключ саме під ECDH цієї сесії. */
  ecdh: { secretKey: Uint8Array; publicKeyHex: string };
  address: string;
}

export function createSimulatedWallet(): SimulatedWallet {
  const identity = secp.keygen();
  const ecdh = secp.keygen();
  return {
    identity: { secretKey: identity.secretKey, publicKeyHex: secp.etc.bytesToHex(identity.publicKey) },
    ecdh: { secretKey: ecdh.secretKey, publicKeyHex: secp.etc.bytesToHex(ecdh.publicKey) },
    address: publicKeyToMinterAddress(secp.etc.bytesToHex(identity.publicKey)),
  };
}

/**
 * Канонічне повідомлення relay для відкликання сесії. Префікс дії
 * обов'язковий: без нього підпис від revoke приймався б і для інших дій.
 */
export function canonicalRevokeMessage(sessionId: string, issuedAt: number): string {
  return `minter-connect:revoke-session:${sessionId}:${issuedAt}`;
}

/** Канонічне повідомлення handshake relay: підпис покриває і ECDH-ключ каналу. */
export function canonicalHandshakeMessage(sessionId: string, ecdhPublicKeyHex: string): string {
  return `minter-connect:handshake:${sessionId}:${ecdhPublicKeyHex.toLowerCase()}`;
}

/**
 * Те, що relay віддає в GET /sessions/:id для підтвердженої сесії, разом із
 * доказом handshake — SDK перевіряє його самостійно.
 */
export function connectedSessionPayload(
  wallet: SimulatedWallet,
  sessionId: string,
  extra: { dexPublicKeyHex?: string; expiresAt?: string | null } = {},
): Record<string, unknown> {
  return {
    status: 'connected',
    dexName: 'Test DEX',
    dexPublicKeyHex: extra.dexPublicKeyHex ?? 'ab'.repeat(33),
    walletAddress: wallet.address,
    walletPublicKeyHex: wallet.ecdh.publicKeyHex,
    identityPublicKeyHex: wallet.identity.publicKeyHex,
    handshakeSignature: signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(sessionId, wallet.ecdh.publicKeyHex),
    ),
    expiresAt: extra.expiresAt ?? null,
  };
}
