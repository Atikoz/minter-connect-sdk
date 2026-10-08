/**
 * Перевірка доказу handshake на боці DEX.
 *
 * Сценарій, від якого це захищає: relay (або TLS-термінуючий проксі перед ним)
 * віддає SDK СВІЙ ECDH-ключ замість ключа гаманця. Далі relay читає всі
 * "E2E-зашифровані" транзакції, перешифровує їх для гаманця, і жодна перевірка
 * адреси цього не помічає — адреса ж справжня.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient, MinterConnectError } from '../src/index.js';
import { handshakeMessage, publicKeyToMinterAddress, verifyHandshake, type HandshakeClaim } from '../src/handshake.js';
import { createFetchStub, FAKE_SESSION_ID } from './helpers/fetch-stub.js';
import { RELAY_URL } from './helpers/connected.js';
import {
  canonicalHandshakeMessage,
  connectedSessionPayload,
  createdSessionReply,
  createSimulatedWallet,
  signMessage,
  TEST_CLIENT_CONFIG,
  TEST_DOMAIN,
  type SimulatedWallet,
} from './helpers/wallet.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function clientReturning(sessionPayload: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const stub = createFetchStub((call) =>
    call.method === 'POST' ? { json: createdSessionReply(FAKE_SESSION_ID) } : { json: sessionPayload },
  );
  vi.stubGlobal('fetch', stub.fetch);
  return new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG, ...config });
}

const NOW = 1_759_800_000_000;
const EXPECT = { expectedDomain: TEST_DOMAIN, maxAgeMs: 10 * 60_000, now: NOW };

function honestClaim(wallet: SimulatedWallet, domain = TEST_DOMAIN, issuedAt = NOW - 1000): HandshakeClaim {
  return {
    sessionId: FAKE_SESSION_ID,
    walletAddress: wallet.address,
    identityPublicKeyHex: wallet.identity.publicKeyHex,
    ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
    domain,
    issuedAt,
    signature: signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(FAKE_SESSION_ID, wallet.ecdh.publicKeyHex, domain, issuedAt),
    ),
  };
}

describe('verifyHandshake', () => {
  it('приймає чесний доказ', () => {
    expect(verifyHandshake(honestClaim(createSimulatedWallet()), EXPECT)).toBeNull();
  });

  it('регістр hex і домену не впливає на результат', () => {
    const wallet = createSimulatedWallet();
    const claim = honestClaim(wallet);
    expect(
      verifyHandshake(
        {
          ...claim,
          walletAddress: `Mx${wallet.address.slice(2).toUpperCase()}`,
          identityPublicKeyHex: wallet.identity.publicKeyHex.toUpperCase(),
          ecdhPublicKeyHex: wallet.ecdh.publicKeyHex.toUpperCase(),
          domain: 'DEX.Test',
        },
        { ...EXPECT, expectedDomain: ' Dex.TEST ' },
      ),
    ).toBeNull();
  });

  it('чужий домен -> domain_mismatch, навіть із валідним підписом', () => {
    // Гаманець чесно підписав фішинговий сайт; relay пересилає цей доказ нам.
    const claim = honestClaim(createSimulatedWallet(), 'dex-test.phish');
    expect(verifyHandshake(claim, EXPECT)).toBe('domain_mismatch');
  });

  it('relay підмінив домен у відповіді на наш -> invalid_signature', () => {
    const claim = honestClaim(createSimulatedWallet(), 'dex-test.phish');
    expect(verifyHandshake({ ...claim, domain: TEST_DOMAIN }, EXPECT)).toBe('invalid_signature');
  });

  it('свіжість: старий підпис і підпис "з майбутнього" -> stale_proof', () => {
    const wallet = createSimulatedWallet();
    expect(verifyHandshake(honestClaim(wallet, TEST_DOMAIN, NOW - 10 * 60_000 - 1), EXPECT)).toBe('stale_proof');
    expect(verifyHandshake(honestClaim(wallet, TEST_DOMAIN, NOW + 120_001), EXPECT)).toBe('stale_proof');
    expect(verifyHandshake(honestClaim(wallet, TEST_DOMAIN, NOW + 119_000), EXPECT)).toBeNull();
    expect(verifyHandshake({ ...honestClaim(wallet), issuedAt: Number.NaN }, EXPECT)).toBe('stale_proof');
  });

  it('maxAgeMs: Infinity вимикає лише "надто старий", а не "з майбутнього"', () => {
    const wallet = createSimulatedWallet();
    const week = 7 * 24 * 3600_000;
    const noFreshness = { ...EXPECT, maxAgeMs: Number.POSITIVE_INFINITY };
    expect(verifyHandshake(honestClaim(wallet, TEST_DOMAIN, NOW - week), noFreshness)).toBeNull();
    expect(verifyHandshake(honestClaim(wallet, TEST_DOMAIN, NOW + 120_001), noFreshness)).toBe('stale_proof');
  });

  it('адреса має виводитись саме з identity-ключа', () => {
    const claim = honestClaim(createSimulatedWallet());
    expect(verifyHandshake({ ...claim, walletAddress: createSimulatedWallet().address }, EXPECT)).toBe('address_mismatch');
  });

  it('підпис прив\'язаний до sessionId, ECDH-ключа і issuedAt', () => {
    const claim = honestClaim(createSimulatedWallet());
    expect(verifyHandshake({ ...claim, sessionId: '00000000-0000-4000-8000-000000000000' }, EXPECT)).toBe('invalid_signature');
    expect(verifyHandshake({ ...claim, ecdhPublicKeyHex: createSimulatedWallet().ecdh.publicKeyHex }, EXPECT)).toBe(
      'invalid_signature',
    );
    expect(verifyHandshake({ ...claim, issuedAt: claim.issuedAt + 1 }, EXPECT)).toBe('invalid_signature');
  });

  it('структурно зіпсований ввід — теж відмова, а не виняток', () => {
    const claim = honestClaim(createSimulatedWallet());
    expect(verifyHandshake({ ...claim, signature: 'не hex' }, EXPECT)).toBe('invalid_signature');
    expect(verifyHandshake({ ...claim, walletAddress: 'Mx_not_an_address' }, EXPECT)).toBe('address_mismatch');
  });

  it('адреса рахується від 64 байт координат; рядок підпису в нижньому регістрі', () => {
    const wallet = createSimulatedWallet();
    expect(publicKeyToMinterAddress(wallet.identity.publicKeyHex)).toBe(wallet.address);
    expect(handshakeMessage(FAKE_SESSION_ID, 'AB'.repeat(33), 'Dex.Test', 1)).toBe(
      `minter-connect:handshake:${FAKE_SESSION_ID}:${'ab'.repeat(33)}:dex.test:1`,
    );
  });
});

describe('waitForConnection перевіряє доказ', () => {
  it('чесний relay -> handshakeVerified: true', async () => {
    const wallet = createSimulatedWallet();
    const client = clientReturning(connectedSessionPayload(wallet, FAKE_SESSION_ID));
    const session = await client.createSession();

    const result = await session.waitForConnection({ intervalMs: 5, timeoutMs: 2000 });

    expect(result.handshakeVerified).toBe(true);
    expect(session.handshakeVerified).toBe(true);
    expect(result.walletAddress).toBe(wallet.address);
  });

  it('relay підмінив ECDH-ключ каналу -> handshake_invalid', async () => {
    const wallet = createSimulatedWallet();
    const mitm = createSimulatedWallet();
    const payload = connectedSessionPayload(wallet, FAKE_SESSION_ID);
    // Адреса й підпис справжні; підмінено лише ключ, на якому будується канал.
    payload.walletPublicKeyHex = mitm.ecdh.publicKeyHex;

    const client = clientReturning(payload);
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 5, timeoutMs: 2000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('handshake_invalid');
    expect(err.relayError).toBe('invalid_signature');
    // Не пропонуємо автоматичне перепідключення: воно піде в той самий relay.
    expect(err.requiresReconnect).toBe(false);
  });

  it('relay назвав чужу адресу -> handshake_invalid (address_mismatch)', async () => {
    const wallet = createSimulatedWallet();
    const payload = connectedSessionPayload(wallet, FAKE_SESSION_ID);
    payload.walletAddress = createSimulatedWallet().address;

    const client = clientReturning(payload);
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 5, timeoutMs: 2000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('handshake_invalid');
    expect(err.relayError).toBe('address_mismatch');
  });

  it('гаманець підписав чужий домен -> handshake_invalid (domain_mismatch)', async () => {
    // Домен у відповіді relay — заявка, а не істина: SDK звіряє з доменом із конфігу.
    const wallet = createSimulatedWallet();
    const client = clientReturning(connectedSessionPayload(wallet, FAKE_SESSION_ID, { domain: 'evil.example' }));
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 5, timeoutMs: 2000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('handshake_invalid');
    expect(err.relayError).toBe('domain_mismatch');
    expect(session.isConnected).toBe(false);
  });

  it('старий handshake у waitForConnection -> handshake_invalid (stale_proof)', async () => {
    const wallet = createSimulatedWallet();
    const client = clientReturning(
      connectedSessionPayload(wallet, FAKE_SESSION_ID, { issuedAt: Date.now() - 11 * 60_000 }),
    );
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 5, timeoutMs: 2000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('handshake_invalid');
    expect(err.relayError).toBe('stale_proof');
  });

  it('relay без доказу -> handshake_unverifiable', async () => {
    const wallet = createSimulatedWallet();
    const payload = connectedSessionPayload(wallet, FAKE_SESSION_ID);
    payload.identityPublicKeyHex = null;
    payload.handshakeSignature = null;

    const client = clientReturning(payload);
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 5, timeoutMs: 2000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('handshake_unverifiable');
  });

  it('requireHandshakeProof: false — підключається, але чесно каже, що не перевірено', async () => {
    const wallet = createSimulatedWallet();
    const payload = connectedSessionPayload(wallet, FAKE_SESSION_ID);
    payload.identityPublicKeyHex = null;
    payload.handshakeSignature = null;

    const client = clientReturning(payload, { requireHandshakeProof: false });
    const session = await client.createSession();

    const result = await session.waitForConnection({ intervalMs: 5, timeoutMs: 2000 });
    expect(result.handshakeVerified).toBe(false);
    expect(result.walletAddress).toBe(wallet.address);
  });
});
