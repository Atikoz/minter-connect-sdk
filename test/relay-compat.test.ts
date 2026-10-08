/**
 * Совместимость формата на проводе.
 *
 * src/crypto.ts — уже третья копия тех же примитивов в проекте (relay,
 * кошелёк, SDK). Копии расходятся тихо: ни одна из них не импортирует другую, поэтому
 * изменение KDF или длины IV в одной компилируется и проходит её собственные тесты —
 * а ломается только в продакшене, в виде "кошелёк подписал неправильно".
 *
 * Поэтому здесь формат проверяется ТРИЖДЫ:
 *  1. независимой реализацией на node:crypto — она есть всегда;
 *  2. фиксированными векторами из бэкенда (test/fixtures/relay-vectors.json,
 *     `npm run fixtures:relay`) — они тоже есть всегда, в том числе в CI, где
 *     соседнего чекаута бэкенда нет;
 *  3. настоящими примитивами relay, если соседний чекаут на месте.
 */

import { createHash, createDecipheriv, createCipheriv } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as secp from '@noble/secp256k1';
import { describe, expect, it } from 'vitest';
import { generateEphemeralKeyPair, deriveSharedAesKey, encryptPayload, decryptPayload } from '../src/crypto.js';
import {
  handshakeMessage as sdkHandshakeMessage,
  publicKeyToMinterAddress as sdkPublicKeyToMinterAddress,
  verifyHandshake as sdkVerifyHandshake,
  PROOF_MAX_CLOCK_SKEW_MS,
  type HandshakeClaim,
  type HandshakeExpectations,
} from '../src/handshake.js';
import { buildSendTransactionRequest, walletRejectionError } from '../src/transaction.js';
import { createSimulatedWallet, publicKeyToMinterAddress, signMessage, verifyMessage } from './helpers/wallet.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Контракт: ключ AES-256 = sha256(compressed ECDH shared point, 33 байта). */
function sharedAesKeyBytes(mySecretKey: Uint8Array, theirPublicKeyHex: string): Buffer {
  const shared = secp.getSharedSecret(mySecretKey, secp.etc.hexToBytes(theirPublicKeyHex));
  expect(shared).toHaveLength(33);
  return createHash('sha256').update(Buffer.from(shared)).digest();
}

/** Контракт: AES-256-GCM, IV 12 байт, на проводе ciphertext = ct || tag(16). */
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

describe('формат на проводе (независимая реализация)', () => {
  it('шифротекст SDK читается сторонней реализацией контракта', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();

    const sdkKey = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);
    const payload = { v: 1, method: 'sendTransaction', params: { to: `Mx${'ab'.repeat(20)}`, amount: '1', coin: 'BIP' } };
    const encrypted = await encryptPayload(sdkKey, payload);

    expect(decryptIndependently(sharedAesKeyBytes(wallet.secretKey, dex.publicKeyHex), encrypted)).toEqual(payload);
  });

  it('шифротекст сторонней реализации читается SDK', async () => {
    const dex = generateEphemeralKeyPair();
    const wallet = generateEphemeralKeyPair();

    const fromWallet = encryptIndependently(sharedAesKeyBytes(wallet.secretKey, dex.publicKeyHex), {
      signedTxHex: 'f8aa01',
    });
    const sdkKey = await deriveSharedAesKey(dex.secretKey, wallet.publicKeyHex);

    expect(await decryptPayload(sdkKey, fromWallet)).toEqual({ signedTxHex: 'f8aa01' });
  });

  it('публичный ключ SDK подходит под схему relay (66 hex, compressed)', () => {
    for (let i = 0; i < 10; i++) {
      expect(generateEphemeralKeyPair().publicKeyHex).toMatch(/^[0-9a-fA-F]{66}$/);
    }
  });

  it('iv и ciphertext подходят под схему relay', async () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const { iv, ciphertext } = await encryptPayload(await deriveSharedAesKey(a.secretKey, b.publicKeyHex), {
      v: 1,
      method: 'sendTransaction',
      params: { to: `Mx${'ab'.repeat(20)}`, amount: '1', coin: 'BIP' },
    });

    expect(iv).toMatch(/^[0-9a-fA-F]{24}$/);
    expect(ciphertext).toMatch(/^[0-9a-fA-F]+$/);
    expect(ciphertext.length).toBeGreaterThanOrEqual(32);
    expect(ciphertext.length).toBeLessThanOrEqual(131_072);
  });
});

describe('формат ключа кошелька', () => {
  it('адрес выводится из 64 байт координат БЕЗ префикса 0x04', () => {
    const wallet = createSimulatedWallet();
    expect(wallet.address).toMatch(/^Mx[0-9a-fA-F]{40}$/);

    const uncompressed65 = secp.Point.fromBytes(secp.etc.hexToBytes(wallet.identity.publicKeyHex)).toBytes(false);

    // Все три представления одного ключа дают ОДИН адрес.
    expect(publicKeyToMinterAddress(hex(uncompressed65))).toBe(wallet.address);
    expect(publicKeyToMinterAddress(hex(uncompressed65.subarray(1)))).toBe(wallet.address);

    // А keccak от всех 65 байт (вместе с префиксом 0x04) — другой, и никакой
    // ошибки при этом не будет: именно так тихо ломается проверка адреса.
    const wrong = `Mx${hex(keccak_256(uncompressed65).slice(-20))}`;
    expect(wrong).not.toBe(wallet.address);
  });

  it('secp.verify на 64-байтном ключе возвращает false БЕЗ ошибки — именно поэтому ключи везде compressed', () => {
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
    // Главная ловушка: НЕ исключение, а тихое false — сбой выглядит как
    // "пользователь подписал неправильно", хотя подпись валидна.
    expect(result).not.toBe(true);
  });
});

/* Второй уровень: фиксированные векторы, сгенерированные кодом бэкенда. */
interface Vectors {
  keys: Record<'identity' | 'walletEcdh' | 'dexEcdh' | 'other', { secretKeyHex: string; publicKeyHex: string }>;
  walletAddress: string;
  handshake: {
    input: { sessionId: string; ecdhPublicKeyHex: string; domain: string; issuedAt: number };
    message: string;
    signature: string;
    proofMaxAgeMs: number;
  };
  verifyHandshake: Array<{ name: string; claim: HandshakeClaim; expect: HandshakeExpectations; result: string | null }>;
  e2e: {
    request: { plaintext: unknown; encrypted: { iv: string; ciphertext: string } };
    signed: { plaintext: unknown; encrypted: { iv: string; ciphertext: string } };
    rejected: Record<string, { plaintext: { error: { code: string; message: string } }; encrypted: { iv: string; ciphertext: string } }>;
  };
}
const vectors = JSON.parse(readFileSync(new URL('./fixtures/relay-vectors.json', import.meta.url), 'utf8')) as Vectors;

describe('векторы бэкенда (test/fixtures/relay-vectors.json)', () => {
  const sk = (hex: string) => secp.etc.hexToBytes(hex);

  it('адрес из identity-ключа', () => {
    expect(sdkPublicKeyToMinterAddress(vectors.keys.identity.publicKeyHex)).toBe(vectors.walletAddress);
  });

  it('строка handshake совпадает байт в байт', () => {
    const { sessionId, ecdhPublicKeyHex, domain, issuedAt } = vectors.handshake.input;
    expect(sdkHandshakeMessage(sessionId, ecdhPublicKeyHex, domain, issuedAt)).toBe(vectors.handshake.message);
  });

  it('подпись кошелька над строкой handshake проверяется (и она детерминирована)', () => {
    expect(verifyMessage(vectors.keys.identity.publicKeyHex, vectors.handshake.message, vectors.handshake.signature)).toBe(true);
    expect(signMessage(sk(vectors.keys.identity.secretKeyHex), vectors.handshake.message)).toBe(vectors.handshake.signature);
  });

  it('допуск на расхождение часов тот же, что в relay', () => {
    expect(PROOF_MAX_CLOCK_SKEW_MS).toBe(vectors.handshake.proofMaxAgeMs);
  });

  for (const v of vectors.verifyHandshake) {
    it(`verifyHandshake: ${v.name} -> ${v.result ?? 'null'}`, () => {
      expect(sdkVerifyHandshake(v.claim, v.expect)).toBe(v.result);
    });
  }

  it('SDK читает шифротексты, сделанные бэкендом на стороне кошелька', async () => {
    const dexKey = await deriveSharedAesKey(sk(vectors.keys.dexEcdh.secretKeyHex), vectors.keys.walletEcdh.publicKeyHex);
    expect(await decryptPayload(dexKey, vectors.e2e.request.encrypted)).toEqual(vectors.e2e.request.plaintext);
    expect(await decryptPayload(dexKey, vectors.e2e.signed.encrypted)).toEqual(vectors.e2e.signed.plaintext);
    for (const { plaintext, encrypted } of Object.values(vectors.e2e.rejected)) {
      expect(await decryptPayload(dexKey, encrypted)).toEqual(plaintext);
    }
  });

  it('запрос SDK имеет ровно ту форму, что и вектор (включая порядок полей)', () => {
    const { params } = vectors.e2e.request.plaintext as { params: { to: string; amount: string; coin: string } };
    expect(JSON.stringify(buildSendTransactionRequest(params))).toBe(JSON.stringify(vectors.e2e.request.plaintext));
  });

  it('коды отказов кошелька мапятся в коды SDK', () => {
    const expected: Record<string, string> = {
      user_rejected: 'signing_rejected',
      bad_request: 'wallet_bad_request',
      signing_failed: 'wallet_signing_failed',
    };
    expect(Object.keys(vectors.e2e.rejected).sort()).toEqual(Object.keys(expected).sort());
    for (const [code, { plaintext }] of Object.entries(vectors.e2e.rejected)) {
      const err = walletRejectionError('req', plaintext);
      expect(err.code).toBe(expected[code]);
      expect(err.walletErrorMessage).toBe(plaintext.error.message);
    }
  });
});

/* Третий уровень: настоящие примитивы relay, если соседний чекаут доступен. */
const BACKEND_DIR = resolve(process.env.MINTER_BACKEND_DIR ?? resolve(process.cwd(), '../minterWallet/minter-backend'));
const RELAY_CRYPTO = resolve(BACKEND_DIR, 'src/shared/crypto-utils.ts');
const RELAY_ADDRESS = resolve(BACKEND_DIR, 'src/shared/address.ts');
const RELAY_HANDSHAKE = resolve(BACKEND_DIR, 'src/shared/handshake.ts');
const relayAvailable = existsSync(RELAY_CRYPTO) && existsSync(RELAY_ADDRESS) && existsSync(RELAY_HANDSHAKE);

describe.skipIf(!relayAvailable)('совместимость с примитивами relay (соседний чекаут)', () => {
  it('SDK -> relay и relay -> SDK', async () => {
    const relay = (await import(pathToFileURL(RELAY_CRYPTO).href)) as typeof import('../src/crypto.js') & {
      generateEphemeralKeyPair: typeof generateEphemeralKeyPair;
    };

    const dex = generateEphemeralKeyPair();
    const walletSide = relay.generateEphemeralKeyPair();

    const sdkKey = await deriveSharedAesKey(dex.secretKey, walletSide.publicKeyHex);
    const relayKey = await relay.deriveSharedAesKey(walletSide.secretKey, dex.publicKeyHex);

    const payload = buildSendTransactionRequest({ to: `Mx${'cd'.repeat(20)}`, amount: '0.000000000000000001', coin: 'LP-123' });
    expect(await relay.decryptPayload(relayKey, await encryptPayload(sdkKey, payload))).toEqual(payload);
    expect(await decryptPayload(sdkKey, await relay.encryptPayload(relayKey, payload))).toEqual(payload);
  });

  it('адрес, выведенный тестовым кошельком, совпадает с тем, который выводит relay', async () => {
    const relayAddress = (await import(pathToFileURL(RELAY_ADDRESS).href)) as {
      publicKeyToMinterAddress: (hex: string) => string;
      isMinterAddress: (v: string) => boolean;
    };

    const wallet = createSimulatedWallet();
    expect(relayAddress.isMinterAddress(wallet.address)).toBe(true);
    expect(relayAddress.publicKeyToMinterAddress(wallet.identity.publicKeyHex)).toBe(wallet.address);
  });

  it('строка и вердикты handshake совпадают с relay на случайных ключах', async () => {
    const relayHandshake = (await import(pathToFileURL(RELAY_HANDSHAKE).href)) as {
      canonicalMessage: { handshake: (sessionId: string, ecdh: string, domain: string, issuedAt: number) => string };
      verifyHandshake: (claim: HandshakeClaim, expect: HandshakeExpectations) => string | null;
    };

    const wallet = createSimulatedWallet();
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const issuedAt = Date.now();

    // Формат сообщения — это и есть контракт: расхождение в одном символе
    // даёт невалидную подпись, которая выглядит как "пользователь подписал не то".
    expect(sdkHandshakeMessage(sessionId, wallet.ecdh.publicKeyHex, 'Dex.Example:8443', issuedAt)).toBe(
      relayHandshake.canonicalMessage.handshake(sessionId, wallet.ecdh.publicKeyHex, 'Dex.Example:8443', issuedAt),
    );

    // Доказательство, собранное так, как его собирает кошелёк, обе реализации оценивают одинаково.
    const claim: HandshakeClaim = {
      sessionId,
      walletAddress: wallet.address,
      identityPublicKeyHex: wallet.identity.publicKeyHex,
      ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
      domain: 'dex.example',
      issuedAt,
      signature: signMessage(
        wallet.identity.secretKey,
        relayHandshake.canonicalMessage.handshake(sessionId, wallet.ecdh.publicKeyHex, 'dex.example', issuedAt),
      ),
    };
    const expectations: HandshakeExpectations[] = [
      { expectedDomain: 'dex.example', maxAgeMs: 600_000 },
      { expectedDomain: 'evil.example', maxAgeMs: 600_000 },
      { expectedDomain: 'dex.example', maxAgeMs: 600_000, now: issuedAt + 600_001 },
    ];
    for (const e of expectations) {
      expect(sdkVerifyHandshake(claim, e)).toBe(relayHandshake.verifyHandshake(claim, e));
    }
    expect(sdkVerifyHandshake(claim, expectations[0]!)).toBeNull();
  });
});
