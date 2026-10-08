/**
 * Минимальный стаб fetch: ровно столько, чтобы проверить маппинг статусов relay
 * в коды SDK, не поднимая ни relay, ни HTTP-сервер.
 */

export interface StubReply {
  status?: number;
  /** Тело, которое будет сериализовано в JSON. */
  json?: unknown;
  /** Сырое тело — для проверки не-JSON ответов (HTML от прокси и т. п.). */
  text?: string;
  headers?: Record<string, string>;
  /** Никогда не отвечать — имитация зависшего соединения. */
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
      // Зависшее соединение: ответ не приходит никогда, выйти можно только
      // через AbortSignal — именно то, что должен сделать таймаут отдельного запроса.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // висим навсегда — тест должен упасть по своему таймауту
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

/** UUID-подобные значения, чтобы тестовые данные были похожи на настоящие ответы relay. */
export const FAKE_SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const FAKE_REQ_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
