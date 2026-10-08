/**
 * Публичные типы SDK.
 *
 * Здесь намеренно нет ничего из крипты и ничего из внутреннего транспорта:
 * всё, что видит интегратор, — это конфиг, параметры транзакции, результат и ошибка
 * с машинным `code`.
 */

export interface MinterConnectConfig {
  /** URL relay-сервера, например 'https://relay.example.com'. Конечный слеш убирается. */
  relayUrl: string;
  /**
   * https-адрес manifest вашего сайта (http — только localhost для разработки): `{ url, name, iconUrl }` (см. README →
   * «Manifest»). Relay и кошелёк САМИ загружают его и показывают юзеру
   * `name` и host из `url` — название/иконку сайт больше не передаёт напрямую.
   */
  manifestUrl: string;
  /**
   * Direct Link Mini App кошелька из BotFather, например
   * 'https://t.me/MinterWalletBot/app'. Без query и fragment: SDK сам добавляет
   * `?startapp=connect_<sessionId>`.
   */
  walletAppLink: string;
  /**
   * СОБСТВЕННЫЙ домен сайта, с которым сверяется домен в подписи handshake
   * (`URL.host`: нижний регистр, порт только нестандартный). По умолчанию —
   * host из manifestUrl.
   *
   * Берётся ТОЛЬКО из конфига и никогда из ответа relay: иначе relay, который
   * переслал подпись, полученную фишинговым сайтом, сам бы и назвал "ожидаемый"
   * домен. Должен совпадать с host manifestUrl — иначе подпись не пройдёт никогда,
   * поэтому конструктор сразу бросает `invalid_request`.
   */
  domain?: string;
  /**
   * Необязательный вебхук: relay сделает POST сюда после финализации каждого
   * запроса на подпись в сессиях, созданных этим клиентом. Должен быть https и не
   * вести в приватную сеть — иначе relay отклонит создание сессии (400
   * `invalid_callback_url`). Можно переопределить для отдельной сессии в
   * createSession({ callbackUrl }).
   *
   * Вебхук ДОПОЛНЯЕТ поллинг, а не заменяет: доставка может не произойти, поэтому
   * waitForSignature() остаётся источником истины.
   */
  callbackUrl?: string;
  /**
   * Таймаут на ОДИН HTTP-запрос к relay (не на весь цикл ожидания).
   * По умолчанию 10 000 мс.
   */
  requestTimeoutMs?: number;
  /**
   * Требовать от relay доказательство handshake (identity-ключ + подпись кошелька) и
   * проверять его самостоятельно. По умолчанию `true`.
   *
   * Цена отключения: walletAddress и ECDH-ключ канала берутся на слово relay,
   * то есть E2E-шифрование перестаёт что-либо гарантировать против него. Текущий relay
   * всегда отдаёт доказательство; опция остаётся только для нестандартных развёртываний.
   */
  requireHandshakeProof?: boolean;
}

/**
 * Параметры запроса `sendTransaction` (формат v1, docs/API.md бэкенда →
 * «Вміст запитів і результатів»). Кошелёк берёт от сайта ТОЛЬКО эти три поля:
 * nonce, комиссию, chainId и payload он определяет сам.
 */
export interface SendTransactionParams {
  /** Адрес получателя: `Mx` + 40 hex. */
  to: string;
  /**
   * Сумма в МОНЕТАХ (не в pip), десятичной строкой: `'1.5'`, `'100'`.
   * Без экспоненты, знака и пробелов, до 18 знаков после точки, строго > 0.
   * Строка, а не number, — чтобы не потерять точность.
   */
  amount: string;
  /** Тикер монеты: 3–10 символов `A-Z0-9-` (`'BIP'`, `'LP-123'`). Регистр НЕ нормализуется. */
  coin: string;
}

export interface ConnectionResult {
  /** Mx-адрес кошелька, который подтвердил подключение. */
  walletAddress: string;
  /**
   * Удалось ли проверить доказательство handshake самостоятельно (адрес выводится из
   * identity-ключа, а подпись покрывает ECDH-ключ канала). `false` бывает только
   * когда relay доказательства не дал и `requireHandshakeProof: false`.
   */
  handshakeVerified: boolean;
  /**
   * ISO-8601 время, когда подтверждённая сессия протухнет (relay по умолчанию
   * даёт 7 дней). После этого момента любой sendTransaction() даст `session_expired`
   * и нужно создавать новую сессию. `null` — если relay не вернул срок.
   */
  expiresAt: string | null;
}

/**
 * Состояние сессии, достаточное для её восстановления после перезапуска DEX.
 *
 * Здесь только то, чего relay не может отдать сам: идентификатор сессии,
 * ephemeral-ключ ECDH и dexToken. Адрес кошелька, срок жизни и доказательство
 * handshake сознательно НЕ сохраняются — всё это заново берётся из
 * GET /sessions/:id и заново проверяется в restoreSession(). Сохранённый
 * `handshakeVerified: true` был бы доверием к собственному хранилищу вместо
 * проверки подписи.
 *
 * ⚠️ ОБА `ephemeralSecretKeyHex` и `dexToken` — СЕКРЕТЫ:
 *  - с ephemeral-ключом можно расшифровать трафик этой сессии;
 *  - с dexToken можно слать от имени сайта запросы на подпись в кошелёк
 *    юзера (подписывает всё равно только юзер, но это прямой путь к фишингу).
 * Храните только на сервере или в зашифрованном виде; в браузере не кладите в
 * localStorage в открытом виде.
 */
export interface SerializedSession {
  /**
   * Версия формата. Сейчас всегда 2. Состояние v1 (до dexToken) не восстанавливается:
   * relay закрыл те сессии при миграции, нужно новое подключение.
   */
  v: 2;
  sessionId: string;
  ephemeralSecretKeyHex: string;
  dexToken: string;
}

/** Статус запроса на подпись в relay. */
export type SigningStatus = 'pending' | 'signed' | 'rejected' | 'expired';

/** Статус pairing-сессии в relay. */
export type SessionStatus = 'pending' | 'connected' | 'revoked' | 'expired';

/**
 * Машинные коды ошибок SDK.
 *
 * Четыре группы, и именно по ним интегратор принимает решение:
 *  - ТЕРМИНАЛЬНЫЕ для сессии (`session_revoked`, `session_expired`,
 *    `session_not_found`, `unauthorized`) — ретрай бессмыслен, нужно новое
 *    подключение;
 *  - ОШИБКИ ИНТЕГРАТОРА (`invalid_request`, `invalid_manifest`,
 *    `session_not_connected`, `crypto_unavailable`) — ретрай бессмыслен,
 *    нужно править вызов или конфиг;
 *  - ОТКАЗЫ КОШЕЛЬКА (`signing_rejected`, `wallet_bad_request`,
 *    `wallet_signing_failed`) — решение кошелька по конкретному запросу;
 *  - ВРЕМЕННЫЕ (`network_error`, `relay_error`, `rate_limited`) — имеет смысл
 *    повторить; для `rate_limited` — не раньше чем через `retryAfterMs`.
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
  /** HTTP-статус ответа relay, если ошибка пришла из HTTP. */
  httpStatus?: number;
  /** Значение поля `error` в теле ответа relay ('session_revoked', 'rate_limited', ...). */
  relayError?: string;
  /**
   * Сколько ждать перед повтором. Для `rate_limited` — из заголовка
   * Retry-After, а если relay его не дал (лимиты сессии) — дефолт SDK.
   */
  retryAfterMs?: number;
  /**
   * Текст от кошелька для `signing_rejected` / `wallet_bad_request` /
   * `wallet_signing_failed`. Для человека, не для логики: ветвитесь по `code`.
   */
  walletErrorMessage?: string;
  cause?: unknown;
}

/**
 * Единственный класс ошибок SDK. Различать случаи нужно по `code`, а не по тексту:
 * текст остаётся человеческим и может измениться, `code` — контракт.
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
   * Имеет ли смысл повторять операцию тем же объектом сессии.
   * `false` означает "создавай новую сессию" или "исправь вызов".
   */
  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'relay_error' || this.code === 'rate_limited';
  }

  /** Мертва ли сессия окончательно и нужно ли новое подключение пользователя. */
  get requiresReconnect(): boolean {
    // handshake_* сознательно НЕ здесь: автоматически переподключаться в ответ на
    // проваленную проверку означает повторить попытку против того же relay,
    // который только что не сошёлся. Это должен увидеть человек.
    // unauthorized здесь: dexToken не подходит к сессии (битое/чужое состояние в
    // хранилище), и новый токен даёт только новая сессия.
    return (
      this.code === 'session_revoked' ||
      this.code === 'session_expired' ||
      this.code === 'session_not_found' ||
      this.code === 'unauthorized'
    );
  }
}
