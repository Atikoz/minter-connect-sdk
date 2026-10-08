/**
 * Публічні типи SDK.
 *
 * Тут навмисно немає нічого з крипти й нічого з внутрішнього транспорту:
 * усе, що бачить інтегратор, — це конфіг, txParams, результат і помилка
 * з машинним `code`.
 */

export interface MinterConnectConfig {
  /** URL relay-сервера, наприклад 'https://relay.example.com'. Без кінцевого слеша. */
  relayUrl: string;
  /** Ім'я, яке юзер побачить у попапі підтвердження в гаманці ("X хоче підключитись"). 1..64 символи. */
  dexName: string;
  /** username бота гаманця в Telegram, БЕЗ @, для генерації deep link. */
  walletBotUsername: string;
  /**
   * Необов'язковий вебхук: relay зробить POST сюди після фіналізації кожного
   * запиту на підпис у сесіях, створених цим клієнтом. Має бути https і не
   * вести у приватну мережу — інакше relay відхилить створення сесії (400
   * `invalid_callback_url`). Можна перевизначити для окремої сесії в
   * createSession({ callbackUrl }).
   *
   * Вебхук ДОПОВНЮЄ поллінг, а не замінює: доставка може не відбутись, тому
   * waitForSignature() лишається джерелом істини.
   */
  callbackUrl?: string;
  /**
   * Таймаут на ОДИН HTTP-запит до relay (не на весь цикл очікування).
   * За замовчуванням 10 000 мс.
   */
  requestTimeoutMs?: number;
  /**
   * Вимагати від relay доказ handshake (identity-ключ + підпис гаманця) і
   * перевіряти його самостійно. За замовчуванням `true`.
   *
   * Вимикайте, лише якщо relay старіший за формат доказу і повертає ці поля
   * як null. Ціна вимкнення: walletAddress і ECDH-ключ каналу беруться на
   * слово relay, тобто E2E-шифрування перестає щось гарантувати проти нього.
   */
  requireHandshakeProof?: boolean;
}

export interface TxParams {
  nonce?: number;
  chainId?: number;
  gasPrice?: number;
  gasCoin?: number | string;
  type: string;
  data: Record<string, unknown>;
  payload?: string;
}

export interface ConnectionResult {
  /** Mx-адреса гаманця, який підтвердив підключення. */
  walletAddress: string;
  /**
   * Чи вдалося перевірити доказ handshake самостійно (адреса виводиться з
   * identity-ключа, а підпис покриває ECDH-ключ каналу). `false` буває лише
   * коли relay доказу не дав і `requireHandshakeProof: false`.
   */
  handshakeVerified: boolean;
  /**
   * ISO-8601 час, коли підтверджена сесія протухне (relay за замовчуванням
   * дає 7 днів). Після цього моменту будь-який sign() дасть `session_expired`
   * і треба створювати нову сесію. `null` — якщо relay не повернув строк.
   */
  expiresAt: string | null;
}

/**
 * Стан сесії, достатній для її відновлення після перезапуску DEX.
 *
 * Тут лише те, чого relay не може віддати сам: ідентифікатор сесії та
 * ephemeral-ключ ECDH. Адреса гаманця, строк життя й доказ handshake свідомо
 * НЕ зберігаються — усе це заново береться з GET /sessions/:id і заново
 * перевіряється у restoreSession(). Збережений `handshakeVerified: true` був
 * би довірою до власного сховища замість перевірки підпису.
 *
 * ⚠️ `ephemeralSecretKeyHex` — СЕКРЕТ. Він не дає доступу до коштів (підписує
 * лише гаманець), але той, хто його дістане, зможе розшифрувати трафік цієї
 * сесії. Шифруйте сховище так само, як це робить сторона гаманця; у браузері
 * не кладіть у localStorage без шифрування.
 */
export interface SerializedSession {
  /** Версія формату. Зараз завжди 1; чужа версія — `invalid_request`. */
  v: 1;
  sessionId: string;
  ephemeralSecretKeyHex: string;
}

/** Статус запиту на підпис у relay. */
export type SigningStatus = 'pending' | 'signed' | 'rejected' | 'expired';

/** Статус pairing-сесії в relay. */
export type SessionStatus = 'pending' | 'connected' | 'revoked' | 'expired';

/**
 * Машинні коди помилок SDK.
 *
 * Три групи, і саме за ними інтегратор ухвалює рішення:
 *  - ТЕРМІНАЛЬНІ для сесії (`session_revoked`, `session_expired`,
 *    `session_not_found`) — ретрай безглуздий, потрібне нове підключення;
 *  - ПОМИЛКИ ІНТЕГРАТОРА (`invalid_request`, `session_not_connected`,
 *    `crypto_unavailable`) — ретрай безглуздий, треба правити виклик;
 *  - ТИМЧАСОВІ (`network_error`, `relay_error`, `rate_limited`) — має сенс
 *    повторити; для `rate_limited` — не раніше ніж через `retryAfterMs`.
 */
export type MinterConnectErrorCode =
  | 'connection_timeout'
  | 'signing_timeout'
  | 'signing_rejected'
  | 'signing_expired'
  | 'session_not_connected'
  | 'handshake_invalid'
  | 'handshake_unverifiable'
  | 'session_revoked'
  | 'session_expired'
  | 'session_not_found'
  | 'request_not_found'
  | 'already_finalized'
  | 'invalid_request'
  | 'rate_limited'
  | 'session_closed'
  | 'crypto_unavailable'
  | 'relay_error'
  | 'network_error';

export interface MinterConnectErrorDetails {
  /** HTTP-статус відповіді relay, якщо помилка прийшла з HTTP. */
  httpStatus?: number;
  /** Значення поля `error` у тілі відповіді relay ('session_revoked', 'rate_limited', ...). */
  relayError?: string;
  /** Скільки чекати перед повтором. Заповнюється для `rate_limited` із заголовка Retry-After. */
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * Єдиний клас помилок SDK. Розрізняти випадки треба за `code`, а не за текстом:
 * текст лишається людським і може змінитись, `code` — контракт.
 */
export class MinterConnectError extends Error {
  readonly code: MinterConnectErrorCode;
  readonly httpStatus?: number;
  readonly relayError?: string;
  readonly retryAfterMs?: number;

  constructor(code: MinterConnectErrorCode, message: string, details: MinterConnectErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'MinterConnectError';
    this.code = code;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
    if (details.relayError !== undefined) this.relayError = details.relayError;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }

  /**
   * Чи має сенс повторювати операцію тим самим об'єктом сесії.
   * `false` означає "створюй нову сесію" або "виправ виклик".
   */
  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'relay_error' || this.code === 'rate_limited';
  }

  /** Чи сесія мертва остаточно і потрібне нове підключення користувача. */
  get requiresReconnect(): boolean {
    // handshake_* свідомо НЕ тут: автоматично перепідключатись у відповідь на
    // провалену перевірку означає повторити спробу проти того самого relay,
    // який щойно не зійшовся. Це має побачити людина.
    return this.code === 'session_revoked' || this.code === 'session_expired' || this.code === 'session_not_found';
  }
}
