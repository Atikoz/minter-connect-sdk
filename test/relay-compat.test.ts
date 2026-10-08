/**
 * Сумісність формату на дроті.
 *
 * src/crypto.ts — вже третя копія тих самих примітивів у проєкті (relay,
 * гаманець, SDK). Копії розходяться тихо: жодна з них не імпортує іншу, тож
 * зміна KDF чи довжини IV в одній компілюється й проходить її власні тести —
 * а ламається тільки у продакшні, у вигляді "гаманець підписав неправильно".
 *
 * Тому тут формат перевіряється ДВІЧІ:
 *  1. незалежною реалізацією на node:crypto (нижче) — вона є завжди;
 *  2. справжніми примітивами relay, якщо сусідній чекаут на місці.
 */

import { createHash, createDecipheriv, createCipheriv } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as secp from '@noble/secp256k1';
import { describe, expect, it } from 'vitest';
import { generateEphemeralKeyPair, deriveSharedAesKey, encryptPayload, decryptPayload } from '../src/crypto.js';
import { handshakeMessage as sdkHandshakeMessage, verifyHandshake as sdkVerifyHandshake } from '../src/handshake.js';
import { createSimulatedWallet, publicKeyToMinterAddress, signMessage, verifyMessage } from './helpers/wallet.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Контракт: ключ AES-256 = sha256(compressed ECDH shared point, 33 байти). */
function sharedAesKeyBytes(mySecretKey: Uint8Array, theirPublicKeyHex: string): Buffer {
  const shared = secp.getSharedSecret(mySecretKey, secp.etc.hexToBytes(theirPublicKeyHex));
  expect(shared).toHaveLength(33);
  return createHash('sha256').update(Buffer.from(shared)).digest();
}

/** Контракт: AES-256-GCM, IV 12 байт, на дроті ciphertext = ct || tag(16). */
function decryptIndependently(keyBytes: Buffer, payload: { iv: string; ciphertext: string }): unknown {
  const raw = Buffer.from(payload.ciphertext, 'hex');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

function encryptIndependently(keyBytes: Buffer, data: unknown): { iv: string; ciphertext: string } {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf8')), cipher.final()]);
  return { iv: iv.toString('hex'), ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('hex') };
}

describe('формат на дроті (незалежна реалізація)', () => {
  it('шифротекст SDK читається сторонньою реалізацією контракту', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();

    const sdkKey = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);
    const payload = { type: '0x01', data: { to: `Mx${'ab'.repeat(20)}`, value: '1' } };
    const encrypted = await encryptPayload(sdkKey, payload);

    expect(decryptIndependently(sharedAesKeyBytes(wallet.secretKey, dex.publicKeyHex), encrypted)).toEqual(payload);
  });

  it('шифротекст сторонньої реалізації читається SDK', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();

    const fromWallet = encryptIndependently(sharedAesKeyBytes(wallet.secretKey, dex.publicKeyHex), {
      signedTxHex: 'f8aa01',
    });
    const sdkKey = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);

    expect(await decryptPayload(sdkKey, fromWallet)).toEqual({ signedTxHex: 'f8aa01' });
  });

  it('публічний ключ SDK підходить під схему relay (66 hex, compressed)', () => {
    for (let i = 0; i < 10; i++) {
      expect(generateEphemeralKeyPair().publicKeyHex).toMatch(/^[0-9a-fA-F]{66}$/);
    }
  });

  it('iv і ciphertext підходять під схему relay', async () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const { iv, ciphertext } = await encryptPayload(await deriveSharedAesKey(a.secretKey, b.publicKeyHex), {
      type: '0x01',
      data: {},
    });

    expect(iv).toMatch(/^[0-9a-fA-F]{24}$/);
    expect(ciphertext).toMatch(/^[0-9a-fA-F]+$/);
    expect(ciphertext.length).toBeGreaterThanOrEqual(32);
    expect(ciphertext.length).toBeLessThanOrEqual(131_072);
  });
});

describe('формат ключа гаманця', () => {
  it('адреса виводиться з 64 байт координат БЕЗ префікса 0x04', () => {
    const wallet = createSimulatedWallet();
    expect(wallet.address).toMatch(/^Mx[0-9a-fA-F]{40}$/);

    const uncompressed65 = secp.Point.fromBytes(secp.etc.hexToBytes(wallet.identity.publicKeyHex)).toBytes(false);

    // Усі три подання одного ключа дають ОДНУ адресу.
    expect(publicKeyToMinterAddress(hex(uncompressed65))).toBe(wallet.address);
    expect(publicKeyToMinterAddress(hex(uncompressed65.subarray(1)))).toBe(wallet.address);

    // А keccak від усіх 65 байт (разом із префіксом 0x04) — іншу, і жодної
    // помилки при цьому не буде: саме так тихо ламається перевірка адреси.
    const wrong = `Mx${hex(keccak_256(uncompressed65).slice(-20))}`;
    expect(wrong).not.toBe(wallet.address);
  });

  it('secp.verify на 64-байтному ключі повертає false БЕЗ помилки — саме тому ключі скрізь compressed', () => {
    const wallet = createSimulatedWallet();
    const signature = signMessage(wallet.identity.secretKey, 'session-id');

    expect(verifyMessage(wallet.identity.publicKeyHex, 'session-id', signature)).toBe(true);

    const raw64 = hex(secp.Point.fromBytes(secp.etc.hexToBytes(wallet.identity.publicKeyHex)).toBytes(false).subarray(1));
    let result: unknown;
    try {
      result = verifyMessage(raw64, 'session-id', signature);
    } catch {
      result = 'threw';
    }
    // Головна пастка: НЕ виняток, а тихе false — збій виглядає як
    // "користувач підписав неправильно", хоча підпис валідний.
    expect(result).not.toBe(true);
  });
});

/* Другий рівень: справжні примітиви relay, якщо сусідній чекаут доступний. */
const RELAY_CRYPTO = resolve(process.cwd(), '../minterWallet/minter-backend/src/shared/crypto-utils.ts');
const RELAY_ADDRESS = resolve(process.cwd(), '../minterWallet/minter-backend/src/shared/address.ts');
const RELAY_HANDSHAKE = resolve(process.cwd(), '../minterWallet/minter-backend/src/shared/handshake.ts');
const relayAvailable = existsSync(RELAY_CRYPTO) && existsSync(RELAY_ADDRESS);

describe.skipIf(!relayAvailable)('сумісність із примітивами relay (сусідній чекаут)', () => {
  it('SDK -> relay і relay -> SDK', async () => {
    const relay = (await import(pathToFileURL(RELAY_CRYPTO).href)) as typeof import('../src/crypto.js') & {
      generateEphemeralKeyPair: typeof generateEphemeralKeyPair;
    };

    const dex = generateEphemeralKeyPair();
    const walletSide = relay.generateEphemeralKeyPair();

    const sdkKey = await deriveSharedAesKey(dex.secretKey, walletSide.publicKeyHex);
    const relayKey = await relay.deriveSharedAesKey(walletSide.secretKey, dex.publicKeyHex);

    const payload = { type: '0x01', data: { to: `Mx${'cd'.repeat(20)}` } };
    expect(await relay.decryptPayload(relayKey, await encryptPayload(sdkKey, payload))).toEqual(payload);
    expect(await decryptPayload(sdkKey, await relay.encryptPayload(relayKey, payload))).toEqual(payload);
  });

  it('адреса, виведена тестовим гаманцем, збігається з тією, яку виводить relay', async () => {
    const relayAddress = (await import(pathToFileURL(RELAY_ADDRESS).href)) as {
      publicKeyToMinterAddress: (hex: string) => string;
      isMinterAddress: (v: string) => boolean;
    };

    const wallet = createSimulatedWallet();
    expect(relayAddress.isMinterAddress(wallet.address)).toBe(true);
    expect(relayAddress.publicKeyToMinterAddress(wallet.identity.publicKeyHex)).toBe(wallet.address);
  });

  it.skipIf(!existsSync(RELAY_HANDSHAKE))(
    'канонічне повідомлення handshake збігається байт у байт із relay',
    async () => {
      const relayHandshake = (await import(pathToFileURL(RELAY_HANDSHAKE).href)) as {
        canonicalMessage: { handshake: (sessionId: string, ecdhPublicKeyHex: string) => string };
        verifyHandshake: (claim: Record<string, string>) => string | null;
      };

      const wallet = createSimulatedWallet();
      const sessionId = '11111111-2222-4333-8444-555555555555';

      // Формат повідомлення — це і є контракт: розбіжність в одному символі
      // дає невалідний підпис, який виглядає як "користувач підписав не те".
      expect(sdkHandshakeMessage(sessionId, wallet.ecdh.publicKeyHex)).toBe(
        relayHandshake.canonicalMessage.handshake(sessionId, wallet.ecdh.publicKeyHex),
      );

      // Доказ, зібраний як його збирає гаманець, приймають ОБИДВІ реалізації.
      const claim = {
        sessionId,
        walletAddress: wallet.address,
        identityPublicKeyHex: wallet.identity.publicKeyHex,
        ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
        signature: signMessage(
          wallet.identity.secretKey,
          relayHandshake.canonicalMessage.handshake(sessionId, wallet.ecdh.publicKeyHex),
        ),
      };
      expect(relayHandshake.verifyHandshake(claim)).toBeNull();
      expect(sdkVerifyHandshake(claim)).toBeNull();
    },
  );
});
