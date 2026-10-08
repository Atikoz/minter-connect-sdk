/**
 * Публічні типи SDK.
 *
 * Тут навмисно немає нічого з крипти й нічого з внутрішнього транспорту:
 * усе, що бачить інтегратор, — це конфіг, параметри транзакції, результат і помилка
 * з машинним `code`.
 */

export interface MinterConnectConfig {
  /** URL relay-сервера, наприклад 'https://relay.example.com'. Кінцевий слеш прибирається. */
  relayUrl: string;
  /**
   * https-адреса manifest вашого сайту (http — лише localhost для розробки): `{ url, name, iconUrl }` (див. README →
   * «Manifest»). Relay і гаманець САМІ завантажують його і показують юзеру
   * `name` і host з `url` — назву/іконку сайт більше не передає напряму.
   */
  manifestUrl: string;
  /**
   * Direct Link Mini App гаманця з BotFather, наприклад
   * 'https://t.me/MinterWalletBot/app'. Без query і fragment: SDK сам додає
   * `?startapp=connect_<sessionId>`.
   */
  walletAppLink: string;
  /**
   * ВЛАСНИЙ домен сайту, з яким звіряється домен у підписі handshake
   * (`URL.host`: нижній регістр, порт лише нестандартний). За замовчуванням —
   * host із manifestUrl.
   *
   * Береться ТІЛЬКИ з конфігу і ніколи з відповіді relay: інакше relay, який
   * переслав підпис, отриманий фішинговим сайтом, сам би й назвав "очікуваний"
   * домен. Має збігатися з host manifestUrl — інакше підпис не пройде ніколи,
   * тому конструктор одразу кидає `invalid_request`.
   */
  domain?: string;
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
   * Ціна вимкнення: walletAddress і ECDH-ключ каналу беруться на слово relay,
   * тобто E2E-шифрування перестає щось гарантувати проти нього. Поточний relay
   * завжди віддає доказ; опція лишається лише для нестандартних розгортань.
   */
  requireHandshakeProof?: boolean;
}

/**
 * Параметри запиту `sendTransaction` (формат v1, docs/API.md бекенду →
 * «Вміст запитів і результатів»). Гаманець бере від сайту ЛИШЕ ці три поля:
 * nonce, комісію, chainId і payload він визначає сам.
 */
export interface SendTransactionParams {
  /** Адреса отримувача: `Mx` + 40 hex. */
  to: string;
  /**
   * Сума в МОНЕТАХ (не в pip), десятковим рядком: `'1.5'`, `'100'`.
   * Без експоненти, знака і пробілів, до 18 знаків після крапки, строго > 0.
   * Рядок, а не number, — щоб не втратити точність.
   */
  amount: string;
  /** Тикер монети: 3–10 символів `A-Z0-9-` (`'BIP'`, `'LP-123'`). Регістр НЕ нормалізується. */
  coin: string;
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
   * дає 7 днів). Після цього моменту будь-який sendTransaction() дасть `session_expired`
   * і треба створювати нову сесію. `null` — якщо relay не повернув строк.
   */
  expiresAt: string | null;
}

/**
 * Стан сесії, достатній для її відновлення після перезапуску DEX.
 *
 * Тут лише те, чого relay не може віддати сам: ідентифікатор сесії,
 * ephemeral-ключ ECDH і dexToken. Адреса гаманця, строк життя й доказ
 * handshake свідомо НЕ зберігаються — усе це заново береться з
 * GET /sessions/:id і заново перевіряється у restoreSession(). Збережений
 * `handshakeVerified: true` був би довірою до власного сховища замість
 * перевірки підпису.
 *
 * ⚠️ ОБИДВА `ephemeralSecretKeyHex` і `dexToken` — СЕКРЕТИ:
 *  - з ephemeral-ключем можна розшифрувати трафік цієї сесії;
 *  - з dexToken можна слати від імені сайту запити на підпис у гаманець
 *    юзера (підписує все одно лише юзер, але це прямий шлях до фішингу).
 * Зберігайте лише на сервері або зашифрованими; у браузері не кладіть у
 * localStorage у відкритому вигляді.
 */
export interface SerializedSession {
  /**
   * Версія формату. Зараз завжди 2. Стан v1 (до dexToken) не відновлюється:
   * relay закрив ті сесії при міграції, потрібне нове підключення.
   */
  v: 2;
  sessionId: string;
  ephemeralSecretKeyHex: string;
  dexToken: string;
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
 *    `session_not_found`, `unauthorized`) — ретрай безглуздий, потрібне нове
 *    підключення;
 *  - ПОМИЛКИ ІНТЕГРАТОРА (`invalid_request`, `invalid_manifest`,
 *    `session_not_connected`, `crypto_unavailable`) — ретрай безглуздий,
 *    треба правити виклик чи конфіг;
 *  - ВІДМОВИ ГАМАНЦЯ (`signing_rejected`, `wallet_bad_request`,
 *    `wallet_signing_failed`) — рішення гаманця щодо конкретного запиту;
 *  - ТИМЧАСОВІ (`network_error`, `relay_error`, `rate_limited`) — має сенс
 *    повторити; для `rate_limited` — не раніше ніж через `retryAfterMs`.
 */
export type MinterConnectErrorCode =
  | 'connection_timeout'
  | 'signing_timeout'
  | 'signing_rejected'
  | 'wallet_bad_request'
  | 'wallet_signing_failed'
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
  | 'invalid_manifest'
  | 'unauthorized'
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
  /**
   * Скільки чекати перед повтором. Для `rate_limited` — із заголовка
   * Retry-After, а якщо relay його не дав (ліміти сесії) — дефолт SDK.
   */
  retryAfterMs?: number;
  /**
   * Текст від гаманця для `signing_rejected` / `wallet_bad_request` /
   * `wallet_signing_failed`. Для людини, не для логіки: розгалужуйтесь за `code`.
   */
  walletErrorMessage?: string;
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
  readonly walletErrorMessage?: string;

  constructor(code: MinterConnectErrorCode, message: string, details: MinterConnectErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'MinterConnectError';
    this.code = code;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
    if (details.relayError !== undefined) this.relayError = details.relayError;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.walletErrorMessage !== undefined) this.walletErrorMessage = details.walletErrorMessage;
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
    // unauthorized тут: dexToken не підходить до сесії (битий/чужий стан у
    // сховищі), і новий токен дає лише нова сесія.
    return (
      this.code === 'session_revoked' ||
      this.code === 'session_expired' ||
      this.code === 'session_not_found' ||
      this.code === 'unauthorized'
    );
  }
}
