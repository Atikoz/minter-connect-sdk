/**
 * Поведение циклов ожидания: терминальные статусы, лимиты, таймауты,
 * отмена. Всё — без настоящей сети и без настоящих часов там,
 * где иначе тест длился бы минуты.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient, MinterConnectError } from '../src/index.js';
import { decryptPayload, encryptPayload } from '../src/crypto.js';
import { applyJitter, growInterval } from '../src/polling.js';
import { createFetchStub, FAKE_REQ_ID, FAKE_SESSION_ID, type StubReply } from './helpers/fetch-stub.js';
import { connectSession, pendingRequestReply, RELAY_URL, VALID_TX } from './helpers/connected.js';
import {
  connectedSessionPayload,
  createdSessionReply,
  createSimulatedWallet,
  TEST_CLIENT_CONFIG,
  TEST_DEX_TOKEN,
} from './helpers/wallet.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function clientWith(reply: (index: number) => StubReply, config: Record<string, unknown> = {}) {
  const stub = createFetchStub((_call, index) => reply(index));
  vi.stubGlobal('fetch', stub.fetch);
  const client = new MinterConnectClient({
    relayUrl: RELAY_URL,
    ...TEST_CLIENT_CONFIG,
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

describe('waitForConnection: терминальные статусы', () => {
  it('revoked -> session_revoked сразу, а не connection_timeout через 2 минуты', async () => {
    const { client, stub } = clientWith((i) =>
      i === 0 ? { json: createdSessionReply(FAKE_SESSION_ID) } : sessionReply('revoked'),
    );
    const session = await client.createSession();

    const startedAt = Date.now();
    const err = (await session
      .waitForConnection({ intervalMs: 50, timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('session_revoked');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(stub.calls).toHaveLength(2); // POST + один GET, без лишнего поллинга
  });

  it('expired -> session_expired сразу', async () => {
    const { client } = clientWith((i) =>
      i === 0 ? { json: createdSessionReply(FAKE_SESSION_ID) } : sessionReply('expired'),
    );
    const session = await client.createSession();

    const err = (await session
      .waitForConnection({ intervalMs: 50, timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('session_expired');
  });

  it('pending опрашивается дальше и доходит до connected', async () => {
    const wallet = createSimulatedWallet();
    const { client, stub } = clientWith((i) => {
      if (i === 0) return { json: createdSessionReply(FAKE_SESSION_ID) };
      if (i < 3) return sessionReply('pending');
      return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID, { expiresAt: '2030-01-01T00:00:00.000Z' }) };
    });
    const session = await client.createSession();

    const result = await session.waitForConnection({ intervalMs: 5, timeoutMs: 5000 });

    expect(result.walletAddress).toBe(wallet.address);
    // C2: expiresAt больше не выбрасывается — DEX знает, когда сессия умрёт.
    expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(session.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(stub.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('rate limit в поллинге', () => {
  it('429 не фатален: SDK ждёт Retry-After и продолжает', async () => {
    const wallet = createSimulatedWallet();
    const { client } = clientWith((i) => {
      if (i === 0) return { json: createdSessionReply(FAKE_SESSION_ID) };
      if (i === 1) return { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '0' } };
      return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID) };
    });
    const session = await client.createSession();

    const result = await session.waitForConnection({ intervalMs: 5, timeoutMs: 5000 });
    expect(result.walletAddress).toBe(wallet.address);
  });

  it('если Retry-After дольше бюджета ожидания — отдаёт именно rate_limited', async () => {
    const { client } = clientWith((i) =>
      i === 0
        ? { json: createdSessionReply(FAKE_SESSION_ID) }
        : { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '300' } },
    );
    const session = await client.createSession();

    const startedAt = Date.now();
    const err = (await session
      .waitForConnection({ intervalMs: 10, timeoutMs: 1000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(300_000);
    // Главное: не спим 5 минут "внутри" таймаута на 1 секунду.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('таймаут отдельного запроса', () => {
  it('зависший ответ прерывается, а не блокирует навсегда', async () => {
    const { client } = clientWith(() => ({ hang: true }), { requestTimeoutMs: 100 });

    const startedAt = Date.now();
    const err = (await client.createSession().catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('network_error');
    expect(err.message).toMatch(/did not respond within 100ms/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('зависание во время поллинга не съедает весь бюджет цикла', async () => {
    const wallet = createSimulatedWallet();
    const { client } = clientWith(
      (i) => {
        if (i === 0) return { json: createdSessionReply(FAKE_SESSION_ID) };
        if (i === 1) return { hang: true };
        return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID) };
      },
      { requestTimeoutMs: 100 },
    );
    const session = await client.createSession();

    // Первый GET виснет; его обрывает таймаут запроса, и именно поэтому цикл
    // успевает сделать второй GET в пределах своего timeoutMs.
    const err = (await session.waitForConnection({ intervalMs: 5, timeoutMs: 3000 }).catch((e: unknown) => e)) as
      | MinterConnectError
      | { walletAddress: string };

    expect((err as MinterConnectError).code ?? 'ok').toBe('network_error');
  });
});

describe('close()', () => {
  it('прерывает уже идущий поллинг', async () => {
    const { client } = clientWith((i) =>
      i === 0 ? { json: createdSessionReply(FAKE_SESSION_ID) } : sessionReply('pending'),
    );
    const session = await client.createSession();

    const pending = session.waitForConnection({ intervalMs: 5000, timeoutMs: 120_000 });
    await new Promise((r) => setTimeout(r, 20));
    session.close();

    const err = (await pending.catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('session_closed');
    expect(session.isClosed).toBe(true);
  });

  it('идемпотентен, а следующие вызовы сразу дают session_closed', async () => {
    const { client } = clientWith(() => ({ json: createdSessionReply(FAKE_SESSION_ID) }));
    const session = await client.createSession();

    session.close();
    session.close();
    session.dispose();

    const err = (await session.waitForConnection().catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('session_closed');
  });
});

describe('подпись', () => {
  it('шифрует ровно { v: 1, method, params }, шлёт dexToken и возвращает signedTxHex', async () => {
    let captured: { iv: string; ciphertext: string } | undefined;
    const { session, walletAesKey, calls } = await connectSession(async (call) => {
      if (call.method === 'POST') {
        captured = (call.body as { encryptedPayload: { iv: string; ciphertext: string } }).encryptedPayload;
        return pendingRequestReply(FAKE_REQ_ID);
      }
      // Кошелёк подписал: шифруем ответ СВОИМ ключом.
      const encryptedResult = await encryptPayload(walletAesKey, { signedTxHex: 'f8a0deadbeef' });
      return { json: { status: 'signed', encryptedResult } };
    });

    const signedTxHex = await session.sendTransaction(VALID_TX, { pollIntervalMs: 5 });

    expect(signedTxHex).toBe('f8a0deadbeef');
    expect(await decryptPayload(walletAesKey, captured!)).toEqual({ v: 1, method: 'sendTransaction', params: VALID_TX });
    expect(calls.some((c) => c.url === `${RELAY_URL}/sessions/${FAKE_SESSION_ID}/requests`)).toBe(true);

    // Все маршруты DEX после POST /sessions — с Bearer-токеном сессии.
    const dexCalls = calls.filter((c) => c.url !== `${RELAY_URL}/sessions`);
    expect(dexCalls.length).toBeGreaterThanOrEqual(3); // GET session, POST request, GET request
    for (const c of dexCalls) expect(c.headers.authorization).toBe(`Bearer ${TEST_DEX_TOKEN}`);
    // А POST /sessions — без него: токена ещё нет.
    expect(calls.find((c) => c.url === `${RELAY_URL}/sessions`)!.headers.authorization).toBeUndefined();
  });

  it('expired -> signing_expired', async () => {
    const expired = await connectSession((call) =>
      call.method === 'POST' ? pendingRequestReply(FAKE_REQ_ID) : { json: { status: 'expired', encryptedResult: null } },
    );
    await expect(expired.session.sendTransaction(VALID_TX, { pollIntervalMs: 5 })).rejects.toMatchObject({
      code: 'signing_expired',
    });
  });

  it('невалидные params -> invalid_request без единого запроса в сеть', async () => {
    const { session, calls } = await connectSession(() => pendingRequestReply(FAKE_REQ_ID));
    const before = calls.length;

    const bad: unknown[] = [
      { ...VALID_TX, to: 'Mx1234' },
      { ...VALID_TX, to: `0x${'11'.repeat(20)}` },
      { ...VALID_TX, amount: 1.5 },
      { ...VALID_TX, amount: '0' },
      { ...VALID_TX, amount: '0.000' },
      { ...VALID_TX, amount: '01' },
      { ...VALID_TX, amount: '1e18' },
      { ...VALID_TX, amount: '-1' },
      { ...VALID_TX, amount: ' 1' },
      { ...VALID_TX, amount: '1.' },
      { ...VALID_TX, amount: `1.${'1'.repeat(19)}` },
      { ...VALID_TX, coin: 'bip' },
      { ...VALID_TX, coin: 'BI' },
      { ...VALID_TX, coin: 'ABCDEFGHIJK' },
      { ...VALID_TX, coin: 'BIP!' },
      { to: VALID_TX.to, amount: VALID_TX.amount },
      { ...VALID_TX, gasCoin: 'BIP' },
      null,
      [VALID_TX.to, VALID_TX.amount, VALID_TX.coin],
    ];
    for (const params of bad) {
      const err = (await session.sendTransaction(params as never).catch((e: unknown) => e)) as MinterConnectError;
      expect(err, JSON.stringify(params)).toBeInstanceOf(MinterConnectError);
      expect(err.code, JSON.stringify(params)).toBe('invalid_request');
    }
    expect(calls.length).toBe(before);

    // Граничные, но валидные значения кошелёк принимает — SDK тоже.
    for (const params of [
      { ...VALID_TX, amount: '0.000000000000000001' },
      { ...VALID_TX, amount: '100' },
      { ...VALID_TX, coin: 'LP-123' },
      { ...VALID_TX, to: `Mx${'AB'.repeat(20)}` },
    ]) {
      await expect(session.requestTransaction(params)).resolves.toBe(FAKE_REQ_ID);
    }
  });

  it('невалидные params дают invalid_request даже до подключения', async () => {
    const { client, stub } = clientWith(() => ({ json: createdSessionReply(FAKE_SESSION_ID) }));
    const session = await client.createSession();

    await expect(session.sendTransaction({ ...VALID_TX, coin: 'bip' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(stub.calls).toHaveLength(1);
  });

  it('sendTransaction() до waitForConnection() -> session_not_connected', async () => {
    const { client } = clientWith(() => ({ json: createdSessionReply(FAKE_SESSION_ID) }));
    const session = await client.createSession();

    await expect(session.sendTransaction(VALID_TX)).rejects.toMatchObject({ code: 'session_not_connected' });
  });

  it('таймаут по умолчанию переживает TTL запроса, а не сдаётся одновременно с ним', async () => {
    // REQUEST_TTL_MS relay и старый дефолт SDK совпадали (90_000), поэтому при
    // протухании выигрывал тот, кто первый: интегратор ловил signing_timeout
    // ("непонятно, попробуйте ещё") вместо signing_expired ("кошелёк не успел").
    const startedAt = Date.now();
    const { session, calls } = await connectSession((call) => {
      if (call.method === 'POST') return pendingRequestReply(FAKE_REQ_ID, 300); // TTL 300 мс
      return Date.now() - startedAt < 500
        ? { json: { status: 'pending', encryptedResult: null } }
        : { json: { status: 'expired', encryptedResult: null } };
    });

    const err = (await session
      .sendTransaction(VALID_TX, { pollIntervalMs: 50 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('signing_expired');
    // Поллинг шёл ПОСЛЕ дедлайна TTL — иначе финальный статус не увидеть.
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(2);
  });

  it('даже на уже протухшем TTL делает финальный запрос', async () => {
    // expiresAt в прошлом: без запаса дедлайн цикла равнялся бы нулю,
    // цикл не выполнился бы ни разу и отдал бы signing_timeout.
    const { session } = await connectSession((call) =>
      call.method === 'POST'
        ? pendingRequestReply(FAKE_REQ_ID, -5_000)
        : { json: { status: 'expired', encryptedResult: null } },
    );

    const err = (await session
      .sendTransaction(VALID_TX, { pollIntervalMs: 50 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('signing_expired');
  });
});

describe('отказы кошелька (encryptedResult в rejected)', () => {
  /** Подключённая сессия; `result` кошелёк шифрует своим ключом и кладёт в encryptedResult. */
  async function connected(reply: (encryptedResult: unknown) => unknown, result?: unknown) {
    let encryptedResult: unknown = null;
    const fixture = await connectSession((call) =>
      call.method === 'POST' ? pendingRequestReply(FAKE_REQ_ID) : { json: reply(encryptedResult) },
    );
    if (result !== undefined) encryptedResult = await encryptPayload(fixture.walletAesKey, result);
    return fixture.session;
  }

  const cases: Array<[string, MinterConnectError['code']]> = [
    ['user_rejected', 'signing_rejected'],
    ['bad_request', 'wallet_bad_request'],
    ['signing_failed', 'wallet_signing_failed'],
    ['something_new', 'wallet_bad_request'],
  ];
  for (const [walletCode, sdkCode] of cases) {
    it(`${walletCode} -> ${sdkCode}, message кошелька в walletErrorMessage`, async () => {
      const session = await connected(
        (encryptedResult) => ({ status: 'rejected', encryptedResult }),
        { error: { code: walletCode, message: `wallet says ${walletCode}` } },
      );
      const err = (await session.sendTransaction(VALID_TX, { pollIntervalMs: 5 }).catch((e: unknown) => e)) as MinterConnectError;
      expect(err.code).toBe(sdkCode);
      expect(err.walletErrorMessage).toBe(`wallet says ${walletCode}`);
      expect(err.isRetryable).toBe(false);
    });
  }

  it('rejected БЕЗ encryptedResult -> wallet_bad_request (так требует API.md)', async () => {
    const session = await connected(() => ({ status: 'rejected', encryptedResult: null }));
    const err = (await session.sendTransaction(VALID_TX, { pollIntervalMs: 5 }).catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('wallet_bad_request');
    expect(err.walletErrorMessage).toBeUndefined();
  });

  it('rejected с шифротекстом, который не расшифровывается, -> wallet_bad_request', async () => {
    const session = await connected(() => ({
      status: 'rejected',
      encryptedResult: { iv: '00'.repeat(12), ciphertext: 'ab'.repeat(32) },
    }));
    const err = (await session.sendTransaction(VALID_TX, { pollIntervalMs: 5 }).catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('wallet_bad_request');
  });
});

describe('джиттер и наращивание интервала', () => {
  it('джиттер держится в пределах ±20%', () => {
    expect(applyJitter(1000, () => 0)).toBe(800);
    expect(applyJitter(1000, () => 1)).toBe(1200);
    expect(applyJitter(1000, () => 0.5)).toBe(1000);
    for (let i = 0; i < 200; i++) {
      const v = applyJitter(2000);
      expect(v).toBeGreaterThanOrEqual(1600);
      expect(v).toBeLessThanOrEqual(2400);
    }
  });

  it('интервал растёт до потолка', () => {
    expect(growInterval(2000, 10_000)).toBe(3000);
    expect(growInterval(9000, 10_000)).toBe(10_000);
    expect(growInterval(10_000, 10_000)).toBe(10_000);
  });
});
