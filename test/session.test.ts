/**
 * Поведінка циклів очікування: термінальні статуси, ліміти, таймаути,
 * скасування. Усе — без справжньої мережі й без справжнього годинника там,
 * де інакше тест тривав би хвилини.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient, MinterConnectError } from '../src/index.js';
import { decryptPayload } from '../src/crypto.js';
import { applyJitter, growInterval } from '../src/polling.js';
import { createFetchStub, FAKE_REQ_ID, FAKE_SESSION_ID, type StubReply } from './helpers/fetch-stub.js';
import { connectSession, pendingRequestReply, RELAY_URL } from './helpers/connected.js';
import { connectedSessionPayload, createSimulatedWallet } from './helpers/wallet.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function clientWith(reply: (index: number) => StubReply, config: Record<string, unknown> = {}) {
  const stub = createFetchStub((_call, index) => reply(index));
  vi.stubGlobal('fetch', stub.fetch);
  const client = new MinterConnectClient({
    relayUrl: RELAY_URL,
    dexName: 'Test DEX',
    walletBotUsername: 'minter_wallet_bot',
    ...config,
  });
  return { client, stub };
}

const sessionReply = (status: string, extra: Record<string, unknown> = {}): StubReply => ({
  json: {
    status,
    dexName: 'Test DEX',
    dexPublicKeyHex: 'ab'.repeat(33),
    walletAddress: null,
    walletPublicKeyHex: null,
    expiresAt: null,
    ...extra,
  },
});

describe('waitForConnection: термінальні статуси', () => {
  it('revoked -> session_revoked одразу, а не connection_timeout через 2 хвилини', async () => {
    const { client, stub } = clientWith((i) =>
      i === 0 ? { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } } : sessionReply('revoked'),
    );
    const session = await client.createSession();

    const startedAt = Date.now();
    const err = (await session
      .waitForConnection({ intervalMs: 50, timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('session_revoked');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(stub.calls).toHaveLength(2); // POST + один GET, без марного поллінгу
  });

  it('expired -> session_expired одразу', async () => {
    const { client } = clientWith((i) =>
      i === 0 ? { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } } : sessionReply('expired'),
    );
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 50, timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('session_expired');
  });

  it('pending поллиться далі й доходить до connected', async () => {
    const wallet = createSimulatedWallet();
    const { client, stub } = clientWith((i) => {
      if (i === 0) return { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } };
      if (i < 3) return sessionReply('pending');
      return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID, { expiresAt: '2030-01-01T00:00:00.000Z' }) };
    });
    const session = await client.createSession();

    const result = await session.waitForConnection({ intervalMs: 5, timeoutMs: 5000 });

    expect(result.walletAddress).toBe(wallet.address);
    // C2: expiresAt більше не викидається — DEX знає, коли сесія помре.
    expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(session.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(stub.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('rate limit у поллінгу', () => {
  it('429 не фатальний: SDK чекає Retry-After і продовжує', async () => {
    const wallet = createSimulatedWallet();
    const { client } = clientWith((i) => {
      if (i === 0) return { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } };
      if (i === 1) return { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '0' } };
      return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID) };
    });
    const session = await client.createSession();

    const result = await session.waitForConnection({ intervalMs: 5, timeoutMs: 5000 });
    expect(result.walletAddress).toBe(wallet.address);
  });

  it('якщо Retry-After довший за бюджет очікування — віддає саме rate_limited', async () => {
    const { client } = clientWith((i) =>
      i === 0
        ? { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } }
        : { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '300' } },
    );
    const session = await client.createSession();

    const startedAt = Date.now();
    const err = (await session
      .waitForConnection({ intervalMs: 10, timeoutMs: 1000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(300_000);
    // Головне: не спимо 5 хвилин "усередині" таймауту на 1 секунду.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('таймаут окремого запиту', () => {
  it('зависла відповідь переривається, а не блокує назавжди', async () => {
    const { client } = clientWith(() => ({ hang: true }), { requestTimeoutMs: 100 });

    const startedAt = Date.now();
    const err = (await client.createSession().catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('network_error');
    expect(err.message).toMatch(/did not respond within 100ms/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('зависання під час поллінгу не з\'їдає весь бюджет циклу', async () => {
    const wallet = createSimulatedWallet();
    const { client } = clientWith(
      (i) => {
        if (i === 0) return { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } };
        if (i === 1) return { hang: true };
        return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID) };
      },
      { requestTimeoutMs: 100 },
    );
    const session = await client.createSession();

    // Перший GET висне; його обриває таймаут запиту, і саме тому цикл
    // встигає зробити другий GET у межах свого timeoutMs.
    const err = (await session.waitForConnection({ intervalMs: 5, timeoutMs: 3000 }).catch((e: unknown) => e)) as
      | MinterConnectError
      | { walletAddress: string };

    expect((err as MinterConnectError).code ?? 'ok').toBe('network_error');
  });
});

describe('close()', () => {
  it('перериває поллінг, що вже триває', async () => {
    const { client } = clientWith((i) =>
      i === 0 ? { json: { sessionId: FAKE_SESSION_ID, expiresAt: null } } : sessionReply('pending'),
    );
    const session = await client.createSession();

    const pending = session.waitForConnection({ intervalMs: 5000, timeoutMs: 120_000 });
    await new Promise((r) => setTimeout(r, 20));
    session.close();

    const err = (await pending.catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('session_closed');
    expect(session.isClosed).toBe(true);
  });

  it('ідемпотентний, а наступні виклики одразу дають session_closed', async () => {
    const { client } = clientWith(() => ({ json: { sessionId: FAKE_SESSION_ID, expiresAt: null } }));
    const session = await client.createSession();

    session.close();
    session.close();
    session.dispose();

    const err = (await session.waitForConnection().catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('session_closed');
  });
});

describe('підпис', () => {
  it('шифрує txParams так, що гаманець їх читає, і повертає signedTxHex', async () => {
    let captured: { iv: string; ciphertext: string } | undefined;
    const { session, walletAesKey, calls } = await connectSession(async (call) => {
      if (call.method === 'POST') {
        captured = (call.body as { encryptedPayload: { iv: string; ciphertext: string } }).encryptedPayload;
        return pendingRequestReply(FAKE_REQ_ID);
      }
      // Гаманець підписав: шифруємо відповідь СВОЇМ ключем.
      const { encryptPayload } = await import('../src/crypto.js');
      const encryptedResult = await encryptPayload(walletAesKey, { signedTxHex: 'f8a0deadbeef' });
      return { json: { status: 'signed', encryptedResult } };
    });

    const txParams = { type: '0x01', chainId: 2, data: { to: 'Mx' + '11'.repeat(20), coin: 0, value: '10' } };
    const signedTxHex = await session.sign(txParams, { pollIntervalMs: 5 });

    expect(signedTxHex).toBe('f8a0deadbeef');
    expect(await decryptPayload(walletAesKey, captured!)).toEqual(txParams);
    expect(calls.some((c) => c.url === `${RELAY_URL}/sessions/${FAKE_SESSION_ID}/requests`)).toBe(true);
  });

  it('rejected -> signing_rejected, expired -> signing_expired', async () => {
    const rejected = await connectSession((call) =>
      call.method === 'POST' ? pendingRequestReply(FAKE_REQ_ID) : { json: { status: 'rejected', encryptedResult: null } },
    );
    await expect(rejected.session.sign({ type: '0x01', data: {} }, { pollIntervalMs: 5 })).rejects.toMatchObject({
      code: 'signing_rejected',
    });
    vi.unstubAllGlobals();

    const expired = await connectSession((call) =>
      call.method === 'POST' ? pendingRequestReply(FAKE_REQ_ID) : { json: { status: 'expired', encryptedResult: null } },
    );
    await expect(expired.session.sign({ type: '0x01', data: {} }, { pollIntervalMs: 5 })).rejects.toMatchObject({
      code: 'signing_expired',
    });
  });

  it('sign() до waitForConnection() -> session_not_connected', async () => {
    const { client } = clientWith(() => ({ json: { sessionId: FAKE_SESSION_ID, expiresAt: null } }));
    const session = await client.createSession();

    await expect(session.sign({ type: '0x01', data: {} })).rejects.toMatchObject({ code: 'session_not_connected' });
  });

  it('дефолтний таймаут переживає TTL запиту, а не здається одночасно з ним', async () => {
    // REQUEST_TTL_MS relay і старий дефолт SDK збігались (90_000), тож на
    // протуханні вигравав той, хто перший: інтегратор ловив signing_timeout
    // ("незрозуміло, спробуйте ще") замість signing_expired ("гаманець не встиг").
    const startedAt = Date.now();
    const { session, calls } = await connectSession((call) => {
      if (call.method === 'POST') return pendingRequestReply(FAKE_REQ_ID, 300); // TTL 300 мс
      return Date.now() - startedAt < 500
        ? { json: { status: 'pending', encryptedResult: null } }
        : { json: { status: 'expired', encryptedResult: null } };
    });

    const err = (await session
      .sign({ type: '0x01', data: {} }, { pollIntervalMs: 50 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('signing_expired');
    // Поллінг тривав ПІСЛЯ дедлайну TTL — інакше фінальний статус не побачити.
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(2);
  });

  it('навіть на вже протухлому TTL робить фінальний запит', async () => {
    // expiresAt у минулому: без запасу дедлайн циклу дорівнював би нулю,
    // цикл не виконався б жодного разу і віддав би signing_timeout.
    const { session } = await connectSession((call) =>
      call.method === 'POST'
        ? pendingRequestReply(FAKE_REQ_ID, -5_000)
        : { json: { status: 'expired', encryptedResult: null } },
    );

    const err = (await session
      .sign({ type: '0x01', data: {} }, { pollIntervalMs: 50 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('signing_expired');
  });
});

describe('джитер і нарощування інтервалу', () => {
  it('джитер тримається в межах ±20%', () => {
    expect(applyJitter(1000, () => 0)).toBe(800);
    expect(applyJitter(1000, () => 1)).toBe(1200);
    expect(applyJitter(1000, () => 0.5)).toBe(1000);
    for (let i = 0; i < 200; i++) {
      const v = applyJitter(2000);
      expect(v).toBeGreaterThanOrEqual(1600);
      expect(v).toBeLessThanOrEqual(2400);
    }
  });

  it('інтервал росте до стелі', () => {
    expect(growInterval(2000, 10_000)).toBe(3000);
    expect(growInterval(9000, 10_000)).toBe(10_000);
    expect(growInterval(10_000, 10_000)).toBe(10_000);
  });
});
