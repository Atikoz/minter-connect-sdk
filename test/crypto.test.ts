import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  generateEphemeralKeyPair,
  deriveSharedAesKey,
  encryptPayload,
  decryptPayload,
} from '../src/crypto.js';
import { MinterConnectError } from '../src/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ECDH + AES-GCM', () => {
  it('обидві сторони виводять один і той самий ключ', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();

    const dexKey = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);
    const walletKey = await deriveSharedAesKey(wallet.secretKey, dex.publicKeyHex);

    const payload = { type: '0x01', data: { to: 'Mx0000000000000000000000000000000000000001', value: '10' } };
    const encrypted = await encryptPayload(dexKey, payload);

    // Головна перевірка: те, що зашифрував DEX, читає гаманець — і навпаки.
    expect(await decryptPayload(walletKey, encrypted)).toEqual(payload);
    const back = await encryptPayload(walletKey, { signedTxHex: 'f8...' });
    expect(await decryptPayload(dexKey, back)).toEqual({ signedTxHex: 'f8...' });
  });

  it('чужий ключ не розшифровує', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();
    const attacker = generateEphemeralKeyPair();

    const dexKey = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);
    const attackerKey = await deriveSharedAesKey(attacker.secretKey, dex.publicKeyHex);

    const encrypted = await encryptPayload(dexKey, { secret: 'tx' });
    await expect(decryptPayload(attackerKey, encrypted)).rejects.toThrow();
  });

  it('кожне шифрування дає новий IV', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();
    const key = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);

    const ivs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { iv } = await encryptPayload(key, { same: 'payload' });
      expect(iv).toMatch(/^[0-9a-f]{24}$/); // рівно 12 байт — вимога схеми relay
      ivs.add(iv);
    }
    // Повторний IV на тому самому ключі в AES-GCM — катастрофа (розкриває XOR
    // відкритих текстів), тому це не стилістична, а безпекова перевірка.
    expect(ivs.size).toBe(25);
  });

  it('змінений шифротекст відхиляється (GCM-тег)', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();
    const key = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);

    const encrypted = await encryptPayload(key, { to: 'Mx1', value: '1' });
    const flipped = encrypted.ciphertext.slice(0, -2) + (encrypted.ciphertext.endsWith('00') ? 'ff' : '00');

    await expect(decryptPayload(key, { ...encrypted, ciphertext: flipped })).rejects.toThrow();
  });
});

describe('crypto.subtle недоступний', () => {
  it('кидає зрозумілу помилку замість "Cannot read properties of undefined"', async () => {
    const keys = generateEphemeralKeyPair();
    const peer = generateEphemeralKeyPair();

    // Небезпечний контекст браузера: crypto є, crypto.subtle — немає.
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });

    const err = await deriveSharedAesKey(keys.secretKey, peer.publicKeyHex).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinterConnectError);
    expect((err as MinterConnectError).code).toBe('crypto_unavailable');
    expect((err as MinterConnectError).message).toMatch(/HTTPS or from localhost/);
  });
});
