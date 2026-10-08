/**
 * Мінімальний стаб fetch: рівно стільки, щоб перевірити мапінг статусів relay
 * у коди SDK, не піднімаючи ані relay, ані HTTP-сервер.
 */

export interface StubReply {
  status?: number;
  /** Тіло, яке буде сериалізоване в JSON. */
  json?: unknown;
  /** Сире тіло — для перевірки не-JSON відповідей (HTML від проксі тощо). */
  text?: string;
  headers?: Record<string, string>;
  /** Ніколи не відповідати — імітація завислого з'єднання. */
  hang?: boolean;
}

export interface StubCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FetchStub {
  fetch: typeof fetch;
  calls: StubCall[];
}

export type StubHandler = (call: StubCall, index: number) => StubReply | Promise<StubReply>;

export function createFetchStub(handler: StubHandler): FetchStub {
  const calls: StubCall[] = [];

  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: StubCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: normalizeHeaders(init?.headers),
    };
    calls.push(call);

    const reply = await handler(call, calls.length - 1);

    if (reply.hang) {
      // Зависле з'єднання: відповідь не приходить ніколи, вийти можна лише
      // через AbortSignal — саме те, що має зробити таймаут окремого запиту.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // висимо назавжди — тест має впасти по своєму таймауту
        const onAbort = () => reject(abortError(signal));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;

  return { fetch: stub, calls };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('This operation was aborted', 'AbortError');
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
}

/** UUID-подібні значення, щоб тестові дані були схожі на справжні відповіді relay. */
export const FAKE_SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const FAKE_REQ_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
