/**
 * Транспорт до relay: один fetch, один таймаут, одна таблиця помилок.
 *
 * Причина існування окремого модуля — щоб client.ts і session.ts мапили
 * відповіді relay ОДНАКОВО. Раніше кожен мав власний `if (!res.ok) throw
 * network_error`, і DEX отримував "мережеву помилку" однаково на 400
 * (помилка інтегратора), 410 (користувач відкликав доступ) і 429 (ліміт) —
 * тобто у двох випадках із трьох ретрай був безглуздий, а SDK його заохочував.
 */

import { MinterConnectError, type MinterConnectErrorCode } from './types.js';

/** Таймаут на ОДИН запит. Не плутати з timeoutMs циклів очікування. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Пауза для `rate_limited`, коли relay не дав Retry-After. Так буває з лімітами
 * сесії (`too_many_pending_requests`, `session_rate_limited`): їх рахує сам
 * маршрут, а не плагін rate-limit, тож заголовка немає.
 */
export const DEFAULT_RETRY_AFTER_MS = 5_000;

export interface RelayRequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Зовнішнє скасування: session.close() перериває запити, що вже в польоті. */
  signal?: AbortSignal;
  /** Таймаут саме цього запиту. За замовчуванням DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Наскрізний X-Request-Id: relay використає його як traceId у своїх логах і у вебхуку. */
  requestId?: string;
  /** dexToken сесії: іде як `Authorization: Bearer <token>` на маршрути DEX. */
  authToken?: string;
}

/**
 * Поле `error` з тіла relay -> код SDK. Мапимо саме за рядком, а не лише за
 * статусом: 410 буває трьох різних сортів (сесію відкликали / сесія протухла /
 * протух конкретний запит), і для DEX це три різні реакції.
 */
const RELAY_ERROR_CODES: Record<string, MinterConnectErrorCode> = {
  session_not_found: 'session_not_found',
  request_not_found: 'request_not_found',
  session_revoked: 'session_revoked',
  session_expired: 'session_expired',
  request_expired: 'signing_expired',
  session_not_connected: 'session_not_connected',
  session_not_pending: 'already_finalized',
  already_finalized: 'already_finalized',
  invalid_callback_url: 'invalid_request',
  missing_dex_token: 'unauthorized',
  invalid_dex_token: 'unauthorized',
  invalid_manifest_url: 'invalid_manifest',
  manifest_unreachable: 'invalid_manifest',
  manifest_invalid: 'invalid_manifest',
  manifest_domain_mismatch: 'invalid_manifest',
  rate_limited: 'rate_limited',
  too_many_pending_requests: 'rate_limited',
  session_rate_limited: 'rate_limited',
};

export async function relayFetch<T>(url: string, options: RelayRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, requestId, authToken } = options;

  // Таймаут вішається на КОЖЕН запит. Без цього зависле TCP-з'єднання тримає
  // await нескінченно, і заявлений timeoutMs циклу поллінгу не спрацьовує —
  // він перевіряється лише МІЖ ітераціями, до яких справа так і не доходить.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // AbortSignal.any є в Node з 20.3 (engines вимагає >= 20.19) і в усіх
  // актуальних браузерах, але типи DOM у цій версії TS про нього ще не знають.
  const composedSignal = signal
    ? (AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }).any([signal, timeoutSignal])
    : timeoutSignal;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (requestId) headers['x-request-id'] = requestId;
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: composedSignal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new MinterConnectError('session_closed', `Request to ${url} was aborted by session.close()`, { cause: err });
    }
    if (timeoutSignal.aborted) {
      throw new MinterConnectError('network_error', `Relay did not respond within ${timeoutMs}ms (${url})`, { cause: err });
    }
    throw new MinterConnectError('network_error', `Failed to reach relay at ${url}: ${errorMessage(err)}`, { cause: err });
  }

  if (!res.ok) throw await toMinterConnectError(res, url);

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new MinterConnectError('relay_error', `Relay returned a non-JSON body for ${url}`, {
      httpStatus: res.status,
      cause: err,
    });
  }
}

async function toMinterConnectError(res: Response, url: string): Promise<MinterConnectError> {
  const { error, message } = await readErrorBody(res);
  const code = RELAY_ERROR_CODES[error ?? ''] ?? codeFromStatus(res.status);
  const retryAfterMs =
    code === 'rate_limited' ? (parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_MS) : undefined;

  const parts = [`Relay responded ${res.status}`, error, message].filter(Boolean);
  return new MinterConnectError(code, `${parts.join(' ')} (${url})`, {
    httpStatus: res.status,
    ...(error !== undefined ? { relayError: error } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

/**
 * Фолбек, коли `error` у тілі не з нашої таблиці — наприклад помилка
 * валідації Fastify (там `error: "Bad Request"`) або 404 на неіснуючий маршрут.
 */
function codeFromStatus(status: number): MinterConnectErrorCode {
  if (status === 400) return 'invalid_request';
  // 401/403 на маршрутах DEX — це завжди dexToken. Повтор з тим самим токеном
  // дасть те саме, тому НЕ relay_error (той вважається тимчасовим).
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 409) return 'already_finalized';
  // Будь-який 410 означає "цього більше немає, перепідключайся" — і це
  // важливіше за точну причину, тому дефолт саме session_expired, а не
  // загальний relay_error, який виглядав би як тимчасовий збій.
  if (status === 410) return 'session_expired';
  // 422 relay віддає лише на manifest: це конфіг сайту, а не збій relay.
  if (status === 422) return 'invalid_manifest';
  if (status === 429) return 'rate_limited';
  return 'relay_error';
}

async function readErrorBody(res: Response): Promise<{ error?: string; message?: string }> {
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') {
      const { error, message } = parsed as { error?: unknown; message?: unknown };
      return {
        ...(typeof error === 'string' ? { error } : {}),
        ...(typeof message === 'string' ? { message } : {}),
      };
    }
  } catch {
    // Не-JSON тіло (наприклад HTML від проксі перед relay) — не привід
    // втратити сам факт помилки; статус ми вже маємо.
  }
  return {};
}

/** Retry-After за RFC 7231 — або секунди, або HTTP-дата. Relay шле секунди. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
