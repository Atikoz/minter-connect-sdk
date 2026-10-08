/**
 * Транспорт к relay: один fetch, один таймаут, одна таблица ошибок.
 *
 * Причина существования отдельного модуля — чтобы client.ts и session.ts мапили
 * ответы relay ОДИНАКОВО. Раньше каждый имел собственный `if (!res.ok) throw
 * network_error`, и DEX получал "сетевую ошибку" одинаково на 400
 * (ошибка интегратора), 410 (пользователь отозвал доступ) и 429 (лимит) —
 * то есть в двух случаях из трёх ретрай был бессмыслен, а SDK его поощрял.
 */

import { MinterConnectError, type MinterConnectErrorCode } from './types.js';

/** Таймаут на ОДИН запрос. Не путать с timeoutMs циклов ожидания. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Пауза для `rate_limited`, когда relay не дал Retry-After. Так бывает с лимитами
 * сессии (`too_many_pending_requests`, `session_rate_limited`): их считает сам
 * маршрут, а не плагин rate-limit, поэтому заголовка нет.
 */
export const DEFAULT_RETRY_AFTER_MS = 5_000;

export interface RelayRequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Внешняя отмена: session.close() прерывает запросы, которые уже в полёте. */
  signal?: AbortSignal;
  /** Таймаут именно этого запроса. По умолчанию DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Сквозной X-Request-Id: relay использует его как traceId в своих логах и в вебхуке. */
  requestId?: string;
  /** dexToken сессии: идёт как `Authorization: Bearer <token>` на маршруты DEX. */
  authToken?: string;
}

/**
 * Поле `error` из тела relay -> код SDK. Мапим именно по строке, а не только по
 * статусу: 410 бывает трёх разных сортов (сессию отозвали / сессия протухла /
 * протух конкретный запрос), и для DEX это три разные реакции.
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

  // Таймаут вешается на КАЖДЫЙ запрос. Без этого зависшее TCP-соединение держит
  // await бесконечно, и заявленный timeoutMs цикла поллинга не срабатывает —
  // он проверяется только МЕЖДУ итерациями, до которых дело так и не доходит.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // AbortSignal.any есть в Node с 20.3 (engines требует >= 20.19) и во всех
  // актуальных браузерах, но типы DOM в этой версии TS о нём ещё не знают.
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
 * Фолбэк, когда `error` в теле не из нашей таблицы — например ошибка
 * валидации Fastify (там `error: "Bad Request"`) или 404 на несуществующий маршрут.
 */
function codeFromStatus(status: number): MinterConnectErrorCode {
  if (status === 400) return 'invalid_request';
  // 401/403 на маршрутах DEX — это всегда dexToken. Повтор с тем же токеном
  // даст то же самое, поэтому НЕ relay_error (тот считается временным).
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 409) return 'already_finalized';
  // Любой 410 означает "этого больше нет, переподключайся" — и это
  // важнее точной причины, поэтому дефолт именно session_expired, а не
  // общий relay_error, который выглядел бы как временный сбой.
  if (status === 410) return 'session_expired';
  // 422 relay отдаёт только на manifest: это конфиг сайта, а не сбой relay.
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
    // Не-JSON тело (например HTML от прокси перед relay) — не повод
    // потерять сам факт ошибки; статус у нас уже есть.
  }
  return {};
}

/** Retry-After по RFC 7231 — либо секунды, либо HTTP-дата. Relay шлёт секунды. */
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
