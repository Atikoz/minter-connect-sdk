/**
 * Мапінг відповідей relay у коди SDK.
 *
 * Це найважливіший тест для DX: до нього будь-який не-2xx був network_error,
 * і DEX однаково ретраїв і відкликану сесію (410), і власний невалідний
 * запит (400), і впирання в ліміт (429).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient } from '../src/index.js';
import { MinterConnectError, type MinterConnectErrorCode } from '../src/types.js';
import { relayFetch } from '../src/http.js';
import { createFetchStub, FAKE_REQ_ID, FAKE_SESSION_ID, type StubReply } from './helpers/fetch-stub.js';
import { connectSession, pendingRequestReply, RELAY_URL } from './helpers/connected.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function codeOf(reply: StubReply): Promise<MinterConnectError> {
  const stub = createFetchStub(() => reply);
  vi.stubGlobal('fetch', stub.fetch);
  const err = await relayFetch(`${RELAY_URL}/sessions/${FAKE_SESSION_ID}`).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MinterConnectError);
  return err as MinterConnectError;
}

describe('HTTP-статуси relay -> code SDK', () => {
  const cases: Array<[string, StubReply, MinterConnectErrorCode]> = [
    ['410 session_revoked', { status: 410, json: { error: 'session_revoked' } }, 'session_revoked'],
    ['410 session_expired', { status: 410, json: { error: 'session_expired' } }, 'session_expired'],
    ['410 request_expired', { status: 410, json: { error: 'request_expired' } }, 'signing_expired'],
    ['404 session_not_found', { status: 404, json: { error: 'session_not_found' } }, 'session_not_found'],
    ['404 request_not_found', { status: 404, json: { error: 'request_not_found' } }, 'request_not_found'],
    ['409 already_finalized', { status: 409, json: { error: 'already_finalized', message: 'signed' } }, 'already_finalized'],
    ['400 session_not_connected', { status: 400, json: { error: 'session_not_connected' } }, 'session_not_connected'],
    ['400 invalid_callback_url', { status: 400, json: { error: 'invalid_callback_url', message: 'private_network' } }, 'invalid_request'],
    [
      '400 FST_ERR_VALIDATION',
      { status: 400, json: { statusCode: 400, error: 'Bad Request', message: "body/dexName must NOT have fewer than 1 characters" } },
      'invalid_request',
    ],
    ['429 rate_limited', { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '7' } }, 'rate_limited'],
    ['500', { status: 500, json: { error: 'internal' } }, 'relay_error'],
    ['502 з HTML від проксі', { status: 502, text: '<html>bad gateway</html>' }, 'relay_error'],
  ];

  for (const [name, reply, expected] of cases) {
    it(`${name} -> ${expected}`, async () => {
      const err = await codeOf(reply);
      expect(err.code).toBe(expected);
      expect(err.httpStatus).toBe(reply.status);
      expect(err.code).not.toBe('network_error');
    });
  }

  it('429 несе retryAfterMs із заголовка Retry-After', async () => {
    const err = await codeOf({ status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '7' } });
    expect(err.retryAfterMs).toBe(7000);
    expect(err.isRetryable).toBe(true);
  });

  it('relayError і message relay доїжджають до інтегратора', async () => {
    const err = await codeOf({ status: 400, json: { error: 'invalid_callback_url', message: 'private_network' } });
    expect(err.relayError).toBe('invalid_callback_url');
    expect(err.message).toContain('private_network');
  });

  it('термінальні коди позначені requiresReconnect', async () => {
    expect((await codeOf({ status: 410, json: { error: 'session_revoked' } })).requiresReconnect).toBe(true);
    expect((await codeOf({ status: 500, json: {} })).requiresReconnect).toBe(false);
  });

  it('справжній мережевий збій лишається network_error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const err = (await relayFetch(`${RELAY_URL}/sessions/x`).catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('network_error');
    expect(err.httpStatus).toBeUndefined();
  });
});

describe('помилки в реальних викликах SDK', () => {
  it('createSession на 429 падає одразу (одноразовий виклик не ретраїться мовчки)', async () => {
    const stub = createFetchStub(() => ({ status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '30' } }));
    vi.stubGlobal('fetch', stub.fetch);

    const client = new MinterConnectClient({ relayUrl: RELAY_URL, dexName: 'D', walletBotUsername: 'b' });
    const err = (await client.createSession().catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(30_000);
    expect(stub.calls).toHaveLength(1); // жодного прихованого ретраю
  });

  it('sign() у відкликану сесію дає session_revoked, а не network_error', async () => {
    const { session } = await connectSession(() => ({ status: 410, json: { error: 'session_revoked' } }));

    const err = (await session
      .sign({ type: '0x01', data: { to: 'Mx1' } })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('session_revoked');
    expect(err.requiresReconnect).toBe(true);
  });

  it('waitForSignature на 404 request_not_found не крутить поллінг до таймауту', async () => {
    const { session } = await connectSession((call) =>
      call.method === 'POST' ? pendingRequestReply(FAKE_REQ_ID) : { status: 404, json: { error: 'request_not_found' } },
    );

    const err = (await session
      .sign({ type: '0x01', data: {} }, { pollIntervalMs: 5, timeoutMs: 5000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('request_not_found');
  });
});
