/**
 * Маппинг ответов relay в коды SDK.
 *
 * Это самый важный тест для DX: до него любой не-2xx был network_error,
 * и DEX одинаково ретраил и отозванную сессию (410), и собственный невалидный
 * запрос (400), и упирание в лимит (429).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient } from '../src/index.js';
import { MinterConnectError, type MinterConnectErrorCode } from '../src/types.js';
import { relayFetch } from '../src/http.js';
import { createFetchStub, FAKE_REQ_ID, FAKE_SESSION_ID, type StubReply } from './helpers/fetch-stub.js';
import { connectSession, pendingRequestReply, RELAY_URL, VALID_TX } from './helpers/connected.js';
import { TEST_CLIENT_CONFIG } from './helpers/wallet.js';
import { DEFAULT_RETRY_AFTER_MS } from '../src/http.js';

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

describe('HTTP-статусы relay -> code SDK', () => {
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
      { status: 400, json: { statusCode: 400, error: 'Bad Request', message: 'body/manifestUrl must match format "uri"' } },
      'invalid_request',
    ],
    ['429 rate_limited', { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '7' } }, 'rate_limited'],
    ['429 too_many_pending_requests', { status: 429, json: { error: 'too_many_pending_requests' } }, 'rate_limited'],
    ['429 session_rate_limited', { status: 429, json: { error: 'session_rate_limited' } }, 'rate_limited'],
    ['401 missing_dex_token', { status: 401, json: { error: 'missing_dex_token' } }, 'unauthorized'],
    ['403 invalid_dex_token', { status: 403, json: { error: 'invalid_dex_token' } }, 'unauthorized'],
    ['401 без тела', { status: 401, text: '' }, 'unauthorized'],
    ['422 invalid_manifest_url', { status: 422, json: { error: 'invalid_manifest_url' } }, 'invalid_manifest'],
    ['422 manifest_unreachable', { status: 422, json: { error: 'manifest_unreachable' } }, 'invalid_manifest'],
    ['422 manifest_invalid', { status: 422, json: { error: 'manifest_invalid' } }, 'invalid_manifest'],
    ['422 manifest_domain_mismatch', { status: 422, json: { error: 'manifest_domain_mismatch' } }, 'invalid_manifest'],
    ['422 неизвестный', { status: 422, json: { error: 'whatever' } }, 'invalid_manifest'],
    ['500', { status: 500, json: { error: 'internal' } }, 'relay_error'],
    ['502 с HTML от прокси', { status: 502, text: '<html>bad gateway</html>' }, 'relay_error'],
  ];

  for (const [name, reply, expected] of cases) {
    it(`${name} -> ${expected}`, async () => {
      const err = await codeOf(reply);
      expect(err.code).toBe(expected);
      expect(err.httpStatus).toBe(reply.status);
      expect(err.code).not.toBe('network_error');
    });
  }

  it('429 несёт retryAfterMs из заголовка Retry-After', async () => {
    const err = await codeOf({ status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '7' } });
    expect(err.retryAfterMs).toBe(7000);
    expect(err.isRetryable).toBe(true);
  });

  it('лимиты сессии без Retry-After получают дефолтный retryAfterMs', async () => {
    for (const error of ['too_many_pending_requests', 'session_rate_limited']) {
      const err = await codeOf({ status: 429, json: { error } });
      expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
      expect(err.relayError).toBe(error);
      expect(err.isRetryable).toBe(true);
    }
  });

  it('unauthorized и invalid_manifest НЕ retryable (раньше падали в relay_error)', async () => {
    const unauthorized = await codeOf({ status: 403, json: { error: 'invalid_dex_token' } });
    expect(unauthorized.isRetryable).toBe(false);
    expect(unauthorized.requiresReconnect).toBe(true);

    const manifest = await codeOf({ status: 422, json: { error: 'manifest_domain_mismatch' } });
    expect(manifest.isRetryable).toBe(false);
    expect(manifest.requiresReconnect).toBe(false);
    expect(manifest.relayError).toBe('manifest_domain_mismatch');
  });

  it('relayError и message relay доезжают до интегратора', async () => {
    const err = await codeOf({ status: 400, json: { error: 'invalid_callback_url', message: 'private_network' } });
    expect(err.relayError).toBe('invalid_callback_url');
    expect(err.message).toContain('private_network');
  });

  it('терминальные коды помечены requiresReconnect', async () => {
    expect((await codeOf({ status: 410, json: { error: 'session_revoked' } })).requiresReconnect).toBe(true);
    expect((await codeOf({ status: 500, json: {} })).requiresReconnect).toBe(false);
  });

  it('настоящий сетевой сбой остаётся network_error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const err = (await relayFetch(`${RELAY_URL}/sessions/x`).catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('network_error');
    expect(err.httpStatus).toBeUndefined();
  });
});

describe('ошибки в реальных вызовах SDK', () => {
  it('createSession на 429 падает сразу (одноразовый вызов не ретраится молча)', async () => {
    const stub = createFetchStub(() => ({ status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '30' } }));
    vi.stubGlobal('fetch', stub.fetch);

    const client = new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG });
    const err = (await client.createSession().catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(30_000);
    expect(stub.calls).toHaveLength(1); // ни одного скрытого ретрая
  });

  it('createSession на 422 manifest_* -> invalid_manifest', async () => {
    const stub = createFetchStub(() => ({ status: 422, json: { error: 'manifest_unreachable' } }));
    vi.stubGlobal('fetch', stub.fetch);

    const client = new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG });
    const err = (await client.createSession().catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('invalid_manifest');
    expect(err.relayError).toBe('manifest_unreachable');
    expect((stub.calls[0]!.body as Record<string, unknown>).manifestUrl).toBe(TEST_CLIENT_CONFIG.manifestUrl);
  });

  it('sendTransaction() в отозванную сессию даёт session_revoked, а не network_error', async () => {
    const { session } = await connectSession(() => ({ status: 410, json: { error: 'session_revoked' } }));

    const err = (await session
      .sendTransaction(VALID_TX)
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('session_revoked');
    expect(err.requiresReconnect).toBe(true);
  });

  it('waitForSignature на 404 request_not_found не крутит поллинг до таймаута', async () => {
    const { session } = await connectSession((call) =>
      call.method === 'POST' ? pendingRequestReply(FAKE_REQ_ID) : { status: 404, json: { error: 'request_not_found' } },
    );

    const err = (await session
      .sendTransaction(VALID_TX, { pollIntervalMs: 5, timeoutMs: 5000 })
      .catch((e: unknown) => e)) as MinterConnectError;

    expect(err.code).toBe('request_not_found');
  });
});
