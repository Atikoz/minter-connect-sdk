/**
 * Внутрішні крипто-примітиви: ECDH (secp256k1) + AES-GCM.
 *
 * НЕ Є публічним API — не експортується з index.ts і заблокований полем
 * "exports" у package.json. Формат на дроті (sha256 від compressed shared
 * point як ключ AES-256-GCM, iv/ciphertext у hex) — це контракт із relay та
 * гаманцем, і його ламати не можна; сама реалізація може змінюватись.
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { MinterConnectError } from './types.js';

export interface EphemeralKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

/**
 * Web Crypto береться ЛІНИВО, на кожен виклик.
 *
 * `const subtle = globalThis.crypto.subtle` на рівні модуля виконувався б
 * під час import: у небезпечному контексті (сторінка по http:// не на
 * localhost) `crypto.subtle` === undefined, і перший же виклик падав би з
 * "Cannot read properties of undefined (reading 'importKey')" — помилкою, за
 * якою неможливо здогадатись, що причина у відсутності HTTPS.
 */
function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new MinterConnectError(
      'crypto_unavailable',
      'Web Crypto (crypto.subtle) is unavailable. In a browser it requires a secure context: ' +
        'serve the page over HTTPS or from localhost. In Node.js it requires v20.19.0 or newer.',
    );
  }
  return c;
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const { secretKey, publicKey } = secp.keygen();
  return { secretKey, publicKey, publicKeyHex: secp.etc.bytesToHex(publicKey) };
}

export async function deriveSharedAesKey(
  mySecretKey: Uint8Array,
  theirPublicKeyHex: string,
): Promise<CryptoKey> {
  const theirPublicKey = secp.etc.hexToBytes(theirPublicKeyHex);
  const sharedPoint = secp.getSharedSecret(mySecretKey, theirPublicKey);
  const keyMaterial = sha256(sharedPoint);
  return getCrypto().subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptPayload(aesKey: CryptoKey, data: unknown): Promise<EncryptedPayload> {
  const c = getCrypto();
  const iv = c.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  return {
    iv: secp.etc.bytesToHex(iv),
    ciphertext: secp.etc.bytesToHex(new Uint8Array(ciphertext)),
  };
}

export async function decryptPayload<T = unknown>(
  aesKey: CryptoKey,
  { iv, ciphertext }: EncryptedPayload,
): Promise<T> {
  const ivBytes = secp.etc.hexToBytes(iv);
  const ctBytes = secp.etc.hexToBytes(ciphertext);
  const plaintext = await getCrypto().subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, aesKey, ctBytes);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Hex ephemeral-ключа для серіалізації сесії. Значення СЕКРЕТНЕ — див. MinterConnectSession.serialize(). */
export function secretKeyToHex(secretKey: Uint8Array): string {
  return secp.etc.bytesToHex(secretKey);
}

/**
 * Розбір ephemeral-ключа зі збереженого стану.
 *
 * Валідація тут, а не при першому використанні, навмисно: сирі байти йдуть
 * у getSharedSecret усередині deriveSharedAesKey, і зіпсоване сховище дало б
 * помилку noble на кшталт "invalid scalar" у момент, коли DEX уже вважає
 * сесію відновленою. Краще впасти на вході з `invalid_request`.
 */
export function secretKeyFromHex(hex: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = secp.etc.hexToBytes(hex.replace(/^0x/, ''));
  } catch (cause) {
    throw new MinterConnectError('invalid_request', 'ephemeralSecretKeyHex is not valid hex', { cause });
  }
  if (bytes.length !== 32 || !secp.utils.isValidSecretKey(bytes)) {
    throw new MinterConnectError('invalid_request', 'ephemeralSecretKeyHex is not a valid secp256k1 secret key');
  }
  return bytes;
}
