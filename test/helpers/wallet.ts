/**
 * Симуляция СТОРОНЫ КОШЕЛЬКА — только для тестов.
 *
 * Здесь живут signMessage/verifyMessage и вывод Mx-адреса: в рантайме SDK
 * они не нужны ни разу (DEX никогда не подписывает handshake — это делает
 * кошелёк), поэтому в dist/ им не место.
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// @noble/secp256k1 v3 не тянет хеши сам — sign/verify без этой прошивки
// падают с "hashes.sha256 not set". Для ECDH (getSharedSecret) она не
// нужна, поэтому в src/crypto.ts её сознательно нет.
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
 * Mx-адрес из публичного ключа. Та же схема, что в Ethereum:
 *   address = last20( keccak256( 64 байта координат БЕЗ префикса 0x04 ) )
 *
 * Именно здесь когда-то был реальный баг: если захешировать все 65 байт (вместе с
 * 0x04) или передать в secp.verify 64-байтный ключ без префикса, ошибки не
 * будет — verify просто вернёт false, и сбой будет выглядеть как "пользователь
 * подписал неправильно". Поэтому координаты достаются через Point.fromBytes.
 */
export function publicKeyToMinterAddress(publicKeyHex: string): string {
  const bytes = secp.etc.hexToBytes(publicKeyHex.replace(/^0x/, ''));
  // 64 байта "сырых" координат — это то, что отдаёт minterjs-wallet.getPublicKey();
  // Point.fromBytes без префикса 0x04 бросает "bad point: not on curve".
  const forPoint = bytes.length === 64 ? secp.etc.concatBytes(Uint8Array.of(0x04), bytes) : bytes;
  const raw64 = secp.Point.fromBytes(forPoint).toBytes(false).subarray(1);
  return `Mx${secp.etc.bytesToHex(keccak_256(raw64).slice(-20))}`;
}

export interface SimulatedWallet {
  /** Ключ, которым кошелёк доказывает владение адресом (handshake, revoke). */
  identity: { secretKey: Uint8Array; publicKeyHex: string };
  /** Отдельный ephemeral-ключ именно под ECDH этой сессии. */
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
 * Каноническое сообщение relay для отзыва сессии. Префикс действия
 * обязателен: без него подпись от revoke принималась бы и для других действий.
 */
export function canonicalRevokeMessage(sessionId: string, issuedAt: number): string {
  return `minter-connect:revoke-session:${sessionId}:${issuedAt}`;
}

/** Домен тестового сайта: host из TEST_MANIFEST_URL. */
export const TEST_DOMAIN = 'dex.test';
export const TEST_MANIFEST_URL = `https://${TEST_DOMAIN}/minter-connect-manifest.json`;
export const TEST_WALLET_APP_LINK = 'https://t.me/MinterWalletBot/app';
/** Формат dexToken relay: 32 байта base64url = 43 символа. */
export const TEST_DEX_TOKEN = 'dexTokenForTests_0123456789abcdefghijklmnop';

/** Каноническое сообщение handshake relay: подпись покрывает ECDH-ключ канала, домен и время. */
export function canonicalHandshakeMessage(
  sessionId: string,
  ecdhPublicKeyHex: string,
  domain: string = TEST_DOMAIN,
  issuedAt: number = Date.now(),
): string {
  return `minter-connect:handshake:${sessionId}:${ecdhPublicKeyHex.toLowerCase()}:${domain.trim().toLowerCase()}:${issuedAt}`;
}

/**
 * То, что relay отдаёт в GET /sessions/:id для подтверждённой сессии, вместе с
 * доказательством handshake — SDK проверяет его самостоятельно.
 */
export function connectedSessionPayload(
  wallet: SimulatedWallet,
  sessionId: string,
  extra: { dexPublicKeyHex?: string; expiresAt?: string | null; domain?: string; issuedAt?: number } = {},
): Record<string, unknown> {
  const domain = extra.domain ?? TEST_DOMAIN;
  const issuedAt = extra.issuedAt ?? Date.now();
  return {
    status: 'connected',
    dexName: 'Test DEX',
    dexDomain: domain,
    dexIconUrl: `https://${domain}/icon.png`,
    manifestUrl: `https://${domain}/minter-connect-manifest.json`,
    dexPublicKeyHex: extra.dexPublicKeyHex ?? 'ab'.repeat(33),
    walletAddress: wallet.address,
    walletPublicKeyHex: wallet.ecdh.publicKeyHex,
    identityPublicKeyHex: wallet.identity.publicKeyHex,
    handshakeSignature: signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(sessionId, wallet.ecdh.publicKeyHex, domain, issuedAt),
    ),
    handshakeIssuedAt: issuedAt,
    expiresAt: extra.expiresAt ?? null,
  };
}

/** То, что relay отдаёт на POST /sessions. */
export function createdSessionReply(sessionId: string, expiresAt: string | null = null): Record<string, unknown> {
  return { sessionId, dexToken: TEST_DEX_TOKEN, dexName: 'Test DEX', dexDomain: TEST_DOMAIN, expiresAt };
}

/** Конфиг клиента, под который собраны все стабы. */
export const TEST_CLIENT_CONFIG = {
  manifestUrl: TEST_MANIFEST_URL,
  walletAppLink: TEST_WALLET_APP_LINK,
} as const;
