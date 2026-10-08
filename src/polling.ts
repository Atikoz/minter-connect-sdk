/**
 * Расписание поллинга: пауза, джиттер, плавное наращивание интервала.
 *
 * Зачем джиттер: фиксированные 2000 мс синхронизируют все сессии одного DEX. Сто
 * параллельных подключений с одного IP бьют в relay ровно в одни и те же моменты,
 * дают пилу по 100 запросов и упираются в rate limit (120 запросов/мин на IP),
 * хотя в среднем нагрузка вполне в пределах.
 */

import { MinterConnectError } from './types.js';

export const JITTER_RATIO = 0.2; // ±20%

/** Случайное отклонение ±20% от базового интервала. */
export function applyJitter(ms: number, random: () => number = Math.random): number {
  const delta = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms - delta + random() * delta * 2));
}

/**
 * Следующий базовый интервал: умножаем на factor до потолка. Долгое ожидание
 * (юзер ушёл пить кофе) не должно стоить relay столько же, сколько первые
 * секунды, когда ответ ожидается вот-вот.
 */
export function growInterval(current: number, maxIntervalMs: number, factor = 1.5): number {
  return Math.min(maxIntervalMs, Math.round(current * factor));
}

/** Пауза, которую можно прервать: session.close() не должен оставлять висеть таймер. */
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
