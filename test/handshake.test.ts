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
import { handshakeMessage, publicKeyToMinterAddress, verifyHandshake } from '../src/handshake.js';
import { createFetchStub, FAKE_SESSION_ID } from './helpers/fetch-stub.js';
import { RELAY_URL } from './helpers/connected.js';
import {
  canonicalHandshakeMessage,
  connectedSessionPayload,
  createSimulatedWallet,
  signMessage,
} from './helpers/wallet.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function clientReturning(sessionPayload: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const stub = createFetchStub((call) =>
    call.method === 'POST'
      ? { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } }
      : { json: sessionPayload },
  );
  vi.stubGlobal('fetch', stub.fetch);
  return new MinterConnectClient({
    relayUrl: RELAY_URL,
    dexName: 'Test DEX',
    walletBotUsername: 'minter_wallet_bot',
    ...config,
  });
}

describe('verifyHandshake', () => {
  it('приймає чесний доказ', () => {
    const wallet = createSimulatedWallet();
    const signature = signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(FAKE_SESSION_ID, wallet.ecdh.publicKeyHex),
    );

    expect(
      verifyHandshake({
        sessionId: FAKE_SESSION_ID,
        walletAddress: wallet.address,
        identityPublicKeyHex: wallet.identity.publicKeyHex,
        ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
        signature,
      }),
    ).toBeNull();
  });

  it('регістр hex не впливає на результат', () => {
    const wallet = createSimulatedWallet();
    const signature = signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(FAKE_SESSION_ID, wallet.ecdh.publicKeyHex),
    );

    expect(
      verifyHandshake({
        sessionId: FAKE_SESSION_ID,
        walletAddress: `Mx${wallet.address.slice(2).toUpperCase()}`,
        identityPublicKeyHex: wallet.identity.publicKeyHex.toUpperCase(),
        ecdhPublicKeyHex: wallet.ecdh.publicKeyHex.toUpperCase(),
        signature,
      }),
    ).toBeNull();
  });

  it('адреса має виводитись саме з identity-ключа', () => {
    const wallet = createSimulatedWallet();
    const other = createSimulatedWallet();
    const signature = signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(FAKE_SESSION_ID, wallet.ecdh.publicKeyHex),
    );

    expect(
      verifyHandshake({
        sessionId: FAKE_SESSION_ID,
        walletAddress: other.address,
        identityPublicKeyHex: wallet.identity.publicKeyHex,
        ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
        signature,
      }),
    ).toBe('address_mismatch');
  });

  it('підпис прив\'язаний до sessionId і до ECDH-ключа', () => {
    const wallet = createSimulatedWallet();
    const signature = signMessage(
      wallet.identity.secretKey,
      canonicalHandshakeMessage(FAKE_SESSION_ID, wallet.ecdh.publicKeyHex),
    );
    const base = {
      sessionId: FAKE_SESSION_ID,
      walletAddress: wallet.address,
      identityPublicKeyHex: wallet.identity.publicKeyHex,
      ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
      signature,
    };

    expect(verifyHandshake({ ...base, sessionId: '00000000-0000-4000-8000-000000000000' })).toBe('invalid_signature');
    expect(verifyHandshake({ ...base, ecdhPublicKeyHex: createSimulatedWallet().ecdh.publicKeyHex })).toBe(
      'invalid_signature',
    );
  });

  it('структурно зіпсований ввід — теж відмова, а не виняток', () => {
    const wallet = createSimulatedWallet();
    expect(
      verifyHandshake({
        sessionId: FAKE_SESSION_ID,
        walletAddress: wallet.address,
        identityPublicKeyHex: wallet.identity.publicKeyHex,
        ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
        signature: 'не hex',
      }),
    ).toBe('invalid_signature');
    expect(
      verifyHandshake({
        sessionId: FAKE_SESSION_ID,
        walletAddress: 'Mx_not_an_address',
        identityPublicKeyHex: wallet.identity.publicKeyHex,
        ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
        signature: '00'.repeat(64),
      }),
    ).toBe('address_mismatch');
  });

  it('адреса рахується від 64 байт координат, а не від 65 з префіксом', () => {
    const wallet = createSimulatedWallet();
    expect(publicKeyToMinterAddress(wallet.identity.publicKeyHex)).toBe(wallet.address);
    expect(handshakeMessage(FAKE_SESSION_ID, 'AB'.repeat(33))).toBe(
      canonicalHandshakeMessage(FAKE_SESSION_ID, 'ab'.repeat(33)),
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
