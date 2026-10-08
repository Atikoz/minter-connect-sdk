/**
 * Розклад поллінгу: пауза, джитер, плавне нарощування інтервалу.
 *
 * Навіщо джитер: фіксовані 2000 мс синхронізують усі сесії одного DEX. Сто
 * паралельних підключень з одного IP б'ють у relay рівно в ті самі моменти,
 * дають пилку по 100 запитів і впираються в rate limit (120 запитів/хв на IP),
 * хоча в середньому навантаження цілком у межах.
 */

import { MinterConnectError } from './types.js';

export const JITTER_RATIO = 0.2; // ±20%

/** Випадкове відхилення ±20% від базового інтервалу. */
export function applyJitter(ms: number, random: () => number = Math.random): number {
  const delta = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms - delta + random() * delta * 2));
}

/**
 * Наступний базовий інтервал: множимо на factor до стелі. Довге очікування
 * (юзер пішов пити каву) не має коштувати relay стільки ж, скільки перші
 * секунди, коли відповідь очікується ось-ось.
 */
export function growInterval(current: number, maxIntervalMs: number, factor = 1.5): number {
  return Math.min(maxIntervalMs, Math.round(current * factor));
}

/** Пауза, яку можна перервати: session.close() не має лишати висіти таймер. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(closedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(closedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function closedError(): MinterConnectError {
  return new MinterConnectError('session_closed', 'Polling was cancelled by session.close()');
}
