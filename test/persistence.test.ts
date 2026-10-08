/**
 * Персистентність сесії на боці DEX і дедлайн пейрінгу з relay.
 *
 * Головне, що тут перевіряється, — не "стан зберігся", а що відновлення
 * НЕ довіряє сховищу: доказ handshake перевіряється заново, і підроблений
 * relay ловиться після релоуду так само, як при першому підключенні.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient, MinterConnectError } from '../src/index.js';
import { decryptPayload } from '../src/crypto.js';
import { createFetchStub, FAKE_REQ_ID, FAKE_SESSION_ID } from './helpers/fetch-stub.js';
import { connectSession, pendingRequestReply, RELAY_URL, VALID_TX } from './helpers/connected.js';
import {
  connectedSessionPayload,
  createdSessionReply,
  createSimulatedWallet,
  TEST_CLIENT_CONFIG,
  TEST_DEX_TOKEN,
  TEST_WALLET_APP_LINK,
  type SimulatedWallet,
} from './helpers/wallet.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SESSION_TTL_MS = 7 * 24 * 3600_000;
/** Handshake підтвердженої сесії, яку відновлюють, підписано давно — до 7 днів тому. */
const THREE_DAYS_AGO = () => Date.now() - 3 * 24 * 3600_000;

function newClient() {
  return new MinterConnectClient({
    relayUrl: RELAY_URL,
    ...TEST_CLIENT_CONFIG,
  });
}

/** Relay після перезапуску DEX: сесія жива, доказ handshake на місці. */
function restoreStub(wallet: SimulatedWallet, payload?: Record<string, unknown>) {
  const stub = createFetchStub((call) => {
    if (call.method === 'GET' && call.url === `${RELAY_URL}/sessions/${FAKE_SESSION_ID}`) {
      return {
        json:
          payload ??
          connectedSessionPayload(wallet, FAKE_SESSION_ID, {
            expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
            issuedAt: THREE_DAYS_AGO(),
          }),
      };
    }
    return { json: { reqId: FAKE_REQ_ID, status: 'pending', expiresAt: new Date(Date.now() + 90_000).toISOString() } };
  });
  vi.stubGlobal('fetch', stub.fetch);
  return stub;
}

describe('serialize / restoreSession', () => {
  it('відновлена сесія підписує тим самим ключем каналу, що й до перезапуску', async () => {
    const { session, wallet, walletAesKey, calls } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const state = session.serialize();
    session.close(); // DEX помер разом з інстансом

    expect(state).toEqual({
      v: 2,
      sessionId: FAKE_SESSION_ID,
      ephemeralSecretKeyHex: expect.any(String),
      dexToken: TEST_DEX_TOKEN,
    });

    const stub = restoreStub(wallet);
    const restored = await newClient().restoreSession(state);

    expect(restored.isConnected).toBe(true);
    expect(restored.walletAddress).toBe(wallet.address);
    expect(restored.handshakeVerified).toBe(true);
    // deepLink відновлюється з конфігу клієнта, а не зі сховища.
    expect(restored.deepLink).toBe(`${TEST_WALLET_APP_LINK}?startapp=connect_${FAKE_SESSION_ID}`);

    await restored.requestTransaction(VALID_TX);

    // Ключ каналу той самий: гаманець читає шифротекст новим інстансом SDK.
    const post = stub.calls.find((c) => c.method === 'POST')!;
    const { encryptedPayload } = post.body as { encryptedPayload: { iv: string; ciphertext: string } };
    await expect(decryptPayload(walletAesKey, encryptedPayload)).resolves.toEqual({
      v: 1,
      method: 'sendTransaction',
      params: VALID_TX,
    });
    expect(calls.length).toBeGreaterThan(0);
    // dexToken зі сховища йде в Bearer, інакше relay відповів би 401.
    for (const c of stub.calls) expect(c.headers.authorization).toBe(`Bearer ${TEST_DEX_TOKEN}`);
    restored.close();
  });

  it('handshake тижневої давності не заважає відновленню (свіжість не перевіряється)', async () => {
    const { session, wallet } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const state = session.serialize();
    session.close();

    restoreStub(
      wallet,
      connectedSessionPayload(wallet, FAKE_SESSION_ID, { issuedAt: Date.now() - SESSION_TTL_MS + 60_000 }),
    );
    const restored = await newClient().restoreSession(state);
    expect(restored.isConnected).toBe(true);
    expect(restored.handshakeVerified).toBe(true);

    // waitForConnection() на вже відновленій сесії не перевіряє доказ
    // повторно з вікном 10 хв — інакше впав би на stale_proof.
    await expect(restored.waitForConnection()).resolves.toMatchObject({ walletAddress: wallet.address });
    restored.close();
  });

  it('домен і підпис при відновленні перевіряються завжди', async () => {
    const { session, wallet } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const state = session.serialize();
    session.close();

    restoreStub(
      wallet,
      connectedSessionPayload(wallet, FAKE_SESSION_ID, { issuedAt: THREE_DAYS_AGO(), domain: 'evil.example' }),
    );
    const err = (await newClient().restoreSession(state).catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('handshake_invalid');
    expect(err.relayError).toBe('domain_mismatch');
  });

  it('перевіряє доказ handshake заново, а не бере збережений handshakeVerified', async () => {
    const { session } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const state = session.serialize();
    session.close();

    // Relay віддає адресу одного гаманця з доказом від зовсім іншого:
    // збережений "handshakeVerified: true" пропустив би це, перевірка — ні.
    const impostor = createSimulatedWallet();
    restoreStub(impostor, {
      ...connectedSessionPayload(impostor, FAKE_SESSION_ID, { expiresAt: null, issuedAt: THREE_DAYS_AGO() }),
      walletAddress: createSimulatedWallet().address,
    });

    const err = await newClient().restoreSession(state).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinterConnectError);
    expect((err as MinterConnectError).code).toBe('handshake_invalid');
  });

  it('мертва сесія дає requiresReconnect, а не мовчазний неробочий обʼєкт', async () => {
    const { session, wallet } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const state = session.serialize();
    session.close();

    restoreStub(wallet, { ...connectedSessionPayload(wallet, FAKE_SESSION_ID), status: 'revoked' });

    const err = await newClient().restoreSession(state).catch((e: unknown) => e);
    expect((err as MinterConnectError).code).toBe('session_revoked');
    expect((err as MinterConnectError).requiresReconnect).toBe(true);
  });

  it('сесія, яку гаманець ще не підтвердив, повертається у стані pending', async () => {
    const { session, wallet } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const state = session.serialize();
    session.close();

    restoreStub(wallet, {
      status: 'pending',
      walletAddress: null,
      walletPublicKeyHex: null,
      identityPublicKeyHex: null,
      handshakeSignature: null,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const restored = await newClient().restoreSession(state);
    expect(restored.isConnected).toBe(false);
    const err = await restored.requestTransaction(VALID_TX).catch((e: unknown) => e);
    expect((err as MinterConnectError).code).toBe('session_not_connected');
    restored.close();
  });

  it('битий стан зі сховища — invalid_request, а не падіння в крипті', async () => {
    const client = newClient();
    const ok = { v: 2, sessionId: FAKE_SESSION_ID, ephemeralSecretKeyHex: '11'.repeat(32), dexToken: TEST_DEX_TOKEN };
    const cases = [
      { ...ok, v: 3 },
      { ...ok, sessionId: '' },
      { ...ok, ephemeralSecretKeyHex: 'not-hex' },
      { ...ok, ephemeralSecretKeyHex: '00'.repeat(32) }, // не валідний скаляр
      { ...ok, dexToken: undefined },
      { ...ok, dexToken: 'short' },
      { ...ok, dexToken: 'has spaces in it, not base64url' },
      null,
    ];

    for (const bad of cases) {
      const err = await client.restoreSession(bad as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MinterConnectError);
      expect((err as MinterConnectError).code).toBe('invalid_request');
    }
  });

  it('стан v1 (до dexToken) — invalid_request з поясненням, без запиту до relay', async () => {
    const stub = createFetchStub(() => ({ status: 500 }));
    vi.stubGlobal('fetch', stub.fetch);

    const err = (await newClient()
      .restoreSession({ v: 1, sessionId: FAKE_SESSION_ID, ephemeralSecretKeyHex: '11'.repeat(32) } as never)
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('invalid_request');
    expect(err.message).toMatch(/new connection/);
    expect(stub.calls).toHaveLength(0);
  });

  it('чужий dexToken у сховищі -> unauthorized з requiresReconnect', async () => {
    const stub = createFetchStub(() => ({ status: 403, json: { error: 'invalid_dex_token' } }));
    vi.stubGlobal('fetch', stub.fetch);

    const err = (await newClient()
      .restoreSession({ v: 2, sessionId: FAKE_SESSION_ID, ephemeralSecretKeyHex: '11'.repeat(32), dexToken: TEST_DEX_TOKEN })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('unauthorized');
    expect(err.requiresReconnect).toBe(true);
  });
});

describe('дедлайн пейрінгу', () => {
  it('береться з expiresAt відповіді POST /sessions, а не з хардкоду 120 с', async () => {
    vi.useFakeTimers();
    const pairingTtlMs = 300_000;
    const stub = createFetchStub((call) => {
      if (call.method === 'POST') {
        return { json: createdSessionReply(FAKE_SESSION_ID, new Date(Date.now() + pairingTtlMs).toISOString()) };
      }
      return {
        json: {
          status: 'pending',
          walletAddress: null,
          walletPublicKeyHex: null,
          identityPublicKeyHex: null,
          handshakeSignature: null,
          expiresAt: new Date(Date.now() + pairingTtlMs).toISOString(),
        },
      };
    });
    vi.stubGlobal('fetch', stub.fetch);

    const session = await newClient().createSession();
    const pending = session.waitForConnection({ intervalMs: 1000, maxIntervalMs: 1000 });
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );

    // Стара поведінка здалась би тут; relay ще хвилини три тримає посилання.
    await vi.advanceTimersByTimeAsync(150_000);
    await expect(Promise.race([settled, Promise.resolve('still-waiting')])).resolves.toBe('still-waiting');

    await vi.advanceTimersByTimeAsync(pairingTtlMs);
    await expect(settled).resolves.toBe('rejected');
    session.close();
  });

  it('явний timeoutMs і далі перекриває дедлайн relay', async () => {
    vi.useFakeTimers();
    const stub = createFetchStub((call) =>
      call.method === 'POST'
        ? { json: createdSessionReply(FAKE_SESSION_ID, new Date(Date.now() + 300_000).toISOString()) }
        : {
            json: {
              status: 'pending',
              walletAddress: null,
              walletPublicKeyHex: null,
              identityPublicKeyHex: null,
              handshakeSignature: null,
              expiresAt: null,
            },
          },
    );
    vi.stubGlobal('fetch', stub.fetch);

    const session = await newClient().createSession();
    const pending = session.waitForConnection({ intervalMs: 1000, maxIntervalMs: 1000, timeoutMs: 5000 });
    const err = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await err) as MinterConnectError).code).toBe('connection_timeout');
    session.close();
  });
});
