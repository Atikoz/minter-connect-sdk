import {
  deriveSharedAesKey,
  encryptPayload,
  decryptPayload,
  secretKeyToHex,
  type EncryptedPayload,
} from './crypto.js';
import { verifyHandshake } from './handshake.js';
import { buildSendTransactionRequest, walletRejectionError } from './transaction.js';
import { relayFetch, DEFAULT_REQUEST_TIMEOUT_MS } from './http.js';
import { applyJitter, growInterval, sleep } from './polling.js';
import {
  MinterConnectError,
  type ConnectionResult,
  type SerializedSession,
  type SessionStatus,
  type SendTransactionParams,
  type SigningStatus,
} from './types.js';

/** То, что relay отдаёт в GET /sessions/:sessionId. */
interface RelaySessionState {
  status: SessionStatus;
  /** Домен, который кошелёк подписал. Заявка relay — сверяется с НАШИМ доменом. */
  dexDomain: string | null;
  walletAddress: string | null;
  walletPublicKeyHex: string | null;
  identityPublicKeyHex: string | null;
  handshakeSignature: string | null;
  handshakeIssuedAt: number | null;
  expiresAt: string | null;
}

export interface SessionDeps {
  relayUrl: string;
  sessionId: string;
  deepLink: string;
  ephemeralSecretKey: Uint8Array;
  /** Bearer-токен сессии из POST /sessions. */
  dexToken: string;
  /** Собственный домен сайта из конфига клиента. */
  expectedDomain: string;
  /** ISO-8601 дедлайн pairing'а из POST /sessions. */
  expiresAt: string | null;
  requestTimeoutMs?: number;
  requireHandshakeProof?: boolean;
}

export interface WaitForConnectionOptions {
  /** Начальный интервал поллинга. Дальше растёт до maxIntervalMs. */
  intervalMs?: number;
  /** Потолок интервала поллинга. */
  maxIntervalMs?: number;
  /** Бюджет всего ожидания. После него — `connection_timeout`. */
  timeoutMs?: number;
}

export interface WaitForSignatureOptions {
  pollIntervalMs?: number;
  maxIntervalMs?: number;
  /**
   * Бюджет ожидания. По умолчанию выводится из `expiresAt`, который relay
   * вернул на POST /requests, плюс запас на несколько интервалов поллинга.
   */
  timeoutMs?: number;
}

export interface RequestTransactionOptions {
  /** X-Request-Id для сквозной трассировки relay -> воркер -> вебхук. */
  requestId?: string;
}

/**
 * Запас сверх TTL запроса. Без него SDK сдаётся ровно в тот момент, когда запрос
 * протухает: гонка решается как `signing_timeout` (ничего не понятно)
 * вместо `signing_expired` (понятно: кошелёк не успел).
 */
const SIGNING_GRACE_MS = 15_000;

/** Фолбэк, если relay не вернул expiresAt: дефолтный REQUEST_TTL_MS relay. */
const FALLBACK_REQUEST_TTL_MS = 90_000;

/**
 * Запас сверх дедлайна pairing'а — ровно та же логика, что и SIGNING_GRACE_MS:
 * даёт relay успеть перевести сессию в `expired`, чтобы пользователь увидел
 * "время вышло", а не безадресный `connection_timeout`.
 */
const PAIRING_GRACE_MS = 10_000;

/** Фолбэк, если relay не вернул expiresAt на POST /sessions: его PAIRING_TTL_MS. */
const FALLBACK_PAIRING_TTL_MS = 300_000;

/**
 * Возраст подписи handshake, с которым её принимает waitForConnection(). Кошелёк
 * подписывает в момент подтверждения, а pairing живёт 5 мин — 10 мин дают запас на
 * медленный поллинг, но не дают подсунуть старую подпись.
 */
const CONNECT_PROOF_MAX_AGE_MS = 10 * 60_000;

/** Сколько держать expiresAt завершённых запросов, прежде чем убрать из мапы. */
const REQUEST_EXPIRY_RETENTION_MS = 10 * 60_000;

/**
 * Один pairing-сеанс с конкретным кошельком юзера. Получается через
 * MinterConnectClient.createSession() — никогда не создаётся напрямую.
 *
 * Вся крипто-механика (ECDH, AES-GCM, identity-vs-ecdh ключи) спрятана здесь.
 * Интегратору не нужно знать ни об одной из этих деталей.
 */
export class MinterConnectSession {
  readonly sessionId: string;
  readonly deepLink: string;
  walletAddress: string | null = null;
  /** Проверено ли доказательство handshake самостоятельно. Заполняется в waitForConnection(). */
  handshakeVerified = false;
  /**
   * ISO-8601 срок жизни. До подтверждения — дедлайн pairing'а (relay даёт
   * 5 минут), после waitForConnection() — дедлайн самой сессии (7 дней).
   */
  expiresAt: string | null;

  private readonly relayUrl: string;
  private readonly ephemeralSecretKey: Uint8Array;
  private readonly dexToken: string;
  private readonly expectedDomain: string;
  private readonly requestTimeoutMs: number;
  private readonly requireHandshakeProof: boolean;
  private readonly abortController = new AbortController();
  private aesKey: CryptoKey | null = null;
  /** reqId -> момент протухания (ms), чтобы waitForSignature знал реальный дедлайн. */
  private readonly requestExpiries = new Map<string, number>();

  constructor(deps: SessionDeps) {
    this.sessionId = deps.sessionId;
    this.deepLink = deps.deepLink;
    this.relayUrl = deps.relayUrl;
    this.ephemeralSecretKey = deps.ephemeralSecretKey;
    this.dexToken = deps.dexToken;
    this.expectedDomain = deps.expectedDomain;
    this.expiresAt = deps.expiresAt;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requireHandshakeProof = deps.requireHandshakeProof ?? true;
  }

  /** true после close(). Любой вызов на закрытой сессии даст `session_closed`. */
  get isClosed(): boolean {
    return this.abortController.signal.aborted;
  }

  /** Готова ли сессия подписывать: handshake пройден и ключ канала выведен. */
  get isConnected(): boolean {
    return this.aesKey !== null && this.walletAddress !== null;
  }

  /**
   * Состояние для сохранения между запусками DEX. Relay держит подтверждённую сессию
   * 7 дней, но ephemeral-ключ живёт только в памяти этого инстанса — без
   * serialize() перезагрузка страницы требует нового пейринга, и этот TTL
   * обслуживает только сторону кошелька.
   *
   * Возвращает ДВА СЕКРЕТА (ephemeral-ключ и dexToken, см. SerializedSession):
   * храните только на сервере или в зашифрованном виде. Восстановление — через
   * MinterConnectClient.restoreSession().
   */
  serialize(): SerializedSession {
    return {
      v: 2,
      sessionId: this.sessionId,
      ephemeralSecretKeyHex: secretKeyToHex(this.ephemeralSecretKey),
      dexToken: this.dexToken,
    };
  }

  /**
   * Один запрос к relay вместо цикла поллинга: подтягивает актуальное состояние
   * восстановленной сессии. Возвращает `null`, если кошелёк ещё не подтвердил
   * подключение, — тогда дальше идёт обычный waitForConnection().
   *
   * Вызывается из restoreSession(); отдельно нужен редко.
   *
   * Свежесть подписи handshake здесь НЕ проверяется: сессию могли подтвердить
   * до 7 дней назад, и с проверкой "не старше 10 мин" восстановление падало бы
   * всегда. Домен, адрес и подпись проверяются как всегда.
   */
  async resume(): Promise<ConnectionResult | null> {
    this.assertOpen();

    const session = await this.fetchSessionState();
    this.expiresAt = session.expiresAt ?? this.expiresAt;

    if (session.status === 'revoked') {
      throw new MinterConnectError(
        'session_revoked',
        `Session ${this.sessionId} was revoked in the wallet; create a new session to reconnect`,
        { relayError: 'session_revoked' },
      );
    }
    if (session.status === 'expired') {
      throw new MinterConnectError(
        'session_expired',
        `Session ${this.sessionId} expired; create a new session`,
        { relayError: 'session_expired' },
      );
    }

    return this.adoptConnectedState(session, Number.POSITIVE_INFINITY);
  }

  /**
   * Прекращает все циклы поллинга этой сессии и прерывает запросы, которые уже в полёте.
   * Вызывайте, когда пользователь ушёл со страницы или отменил операцию:
   * иначе waitForConnection() продолжит долбить relay до своего таймаута.
   *
   * Сессию на relay это НЕ отзывает (отозвать может только кошелёк) — это
   * локальное освобождение ресурсов. Идемпотентный.
   */
  close(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  /** Алиас к close() для `await using` / привычного dispose-именования. */
  dispose(): void {
    this.close();
  }

  /** Опрашивает relay, пока юзер не подтвердит подключение в кошельке (или пока не выйдет время). */
  async waitForConnection(options: WaitForConnectionOptions = {}): Promise<ConnectionResult> {
    const { intervalMs = 2000, maxIntervalMs = 10_000 } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultPairingTimeoutMs();
    this.assertOpen();

    // Восстановленная сессия уже проверена в resume(). Повторная проверка здесь
    // шла бы с окном 10 мин и отбрасывала бы handshake, подписанный вчера.
    if (this.isConnected) return this.connectionResult();

    const deadline = Date.now() + timeoutMs;
    let interval = intervalMs;

    while (Date.now() < deadline) {
      const session = await this.pollWithRateLimit(() => this.fetchSessionState(), deadline);

      this.expiresAt = session.expiresAt ?? this.expiresAt;

      // Терминальные статусы. Раньше цикл их игнорировал и крутился до конца
      // timeoutMs, после чего бросал connection_timeout — то есть сообщал
      // НЕВЕРНУЮ причину: пользователь не "не успел", он отказал или
      // сессия уже мертва, и ждать не было смысла с первой же итерации.
      if (session.status === 'revoked') {
        throw new MinterConnectError(
          'session_revoked',
          `Session ${this.sessionId} was revoked in the wallet; create a new session to reconnect`,
          { relayError: 'session_revoked' },
        );
      }
      if (session.status === 'expired') {
        throw new MinterConnectError(
          'session_expired',
          `Session ${this.sessionId} expired before the wallet confirmed it; create a new session`,
          { relayError: 'session_expired' },
        );
      }

      const connected = await this.adoptConnectedState(session, CONNECT_PROOF_MAX_AGE_MS);
      if (connected) return connected;

      await this.sleepUntil(interval, deadline);
      interval = growInterval(interval, maxIntervalMs);
    }

    throw new MinterConnectError('connection_timeout', `Wallet did not confirm connection within ${timeoutMs}ms`);
  }

  /**
   * Просит кошелёк подписать перевод и ждёт результат. Это самый простой
   * способ использования SDK — большинству интеграторов другого и не нужно.
   *
   * Возвращает signedTxHex. В сеть его отправляет САЙТ (Gate/Node API,
   * `send_transaction`): ни relay, ни кошелёк транзакцию не транслируют.
   */
  async sendTransaction(
    params: SendTransactionParams,
    options: WaitForSignatureOptions & RequestTransactionOptions = {},
  ): Promise<string> {
    const reqId = await this.requestTransaction(params, options);
    return this.waitForSignature(reqId, options);
  }

  /**
   * Создаёт запрос на подпись, возвращает reqId сразу — для интеграторов, которым
   * нужно отправить несколько транзакций и ждать их отдельно/параллельно.
   *
   * Некорректные params дают `invalid_request` ДО любого запроса в сеть.
   */
  async requestTransaction(params: SendTransactionParams, options: RequestTransactionOptions = {}): Promise<string> {
    this.assertOpen();
    const request = buildSendTransactionRequest(params);
    this.assertConnected();

    const encryptedPayload = await encryptPayload(this.aesKey!, request);
    const { reqId, expiresAt } = await this.post<{ reqId: string; status: SigningStatus; expiresAt: string }>(
      `${this.relayUrl}/sessions/${this.sessionId}/requests`,
      { encryptedPayload },
      options.requestId,
    );

    this.rememberRequestExpiry(reqId, expiresAt);
    return reqId;
  }

  /**
   * Ждёт результат конкретного reqId, полученного от requestTransaction().
   * Возвращает signedTxHex; отказ кошелька — `signing_rejected`,
   * `wallet_bad_request` или `wallet_signing_failed`.
   */
  async waitForSignature(reqId: string, options: WaitForSignatureOptions = {}): Promise<string> {
    this.assertConnected();
    const { pollIntervalMs = 2000, maxIntervalMs = 5000 } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultSigningTimeoutMs(reqId);

    const deadline = Date.now() + timeoutMs;
    let interval = pollIntervalMs;

    try {
      while (Date.now() < deadline) {
        const result = await this.pollWithRateLimit(
          () =>
            this.get<{ status: SigningStatus; encryptedResult: EncryptedPayload | null }>(
              `${this.relayUrl}/requests/${reqId}`,
            ),
          deadline,
        );

        if (result.status === 'signed') return await this.readSignedResult(reqId, result.encryptedResult);
        if (result.status === 'rejected') {
          // Relay также переводит pending-запросы в 'rejected' без результата,
          // когда кошелёк отзывает сессию, — это тоже wallet_bad_request.
          throw walletRejectionError(reqId, await this.tryDecrypt(result.encryptedResult));
        }
        if (result.status === 'expired') {
          throw new MinterConnectError('signing_expired', 'Signing request expired before the wallet responded');
        }

        await this.sleepUntil(interval, deadline);
        interval = growInterval(interval, maxIntervalMs);
      }
    } finally {
      this.requestExpiries.delete(reqId);
    }

    throw new MinterConnectError('signing_timeout', `Signing request ${reqId} was not resolved within ${timeoutMs}ms`);
  }

  /* ------------------------------------------------------------------ *
   * Внутреннее
   * ------------------------------------------------------------------ */

  private async readSignedResult(reqId: string, encryptedResult: EncryptedPayload | null): Promise<string> {
    const result = await this.tryDecrypt(encryptedResult);
    const signedTxHex = result && typeof result === 'object' ? (result as { signedTxHex?: unknown }).signedTxHex : undefined;
    if (typeof signedTxHex !== 'string' || !/^(0x)?[0-9a-fA-F]+$/.test(signedTxHex)) {
      throw new MinterConnectError(
        'relay_error',
        `Request ${reqId} is 'signed', but the result is missing or unreadable (no valid signedTxHex)`,
      );
    }
    return signedTxHex;
  }

  /** `undefined` — результата нет или он не расшифровывается этим ключом. */
  private async tryDecrypt(encrypted: EncryptedPayload | null | undefined): Promise<unknown> {
    if (!encrypted) return undefined;
    try {
      return await decryptPayload<unknown>(this.aesKey!, encrypted);
    } catch (err) {
      // Отсутствующий Web Crypto — проблема окружения, а не результата.
      if (err instanceof MinterConnectError) throw err;
      return undefined;
    }
  }

  private connectionResult(): ConnectionResult {
    return { walletAddress: this.walletAddress!, handshakeVerified: this.handshakeVerified, expiresAt: this.expiresAt };
  }

  private fetchSessionState(): Promise<RelaySessionState> {
    return this.get<RelaySessionState>(`${this.relayUrl}/sessions/${this.sessionId}`);
  }

  /**
   * Общий путь для waitForConnection() и resume(): проверить доказательство,
   * запомнить адрес, вывести ключ канала. `null` — сессия ещё не connected.
   *
   * Доказательство проверяется КАЖДЫЙ РАЗ, в том числе после восстановления из хранилища.
   * Поэтому персистентность ничего не ослабляет: сохранённого `handshakeVerified` не
   * существует, есть только свежая подпись кошелька, проверенная заново.
   */
  private async adoptConnectedState(
    session: RelaySessionState,
    maxProofAgeMs: number,
  ): Promise<ConnectionResult | null> {
    if (session.status !== 'connected' || !session.walletAddress || !session.walletPublicKeyHex) return null;

    const handshakeVerified = this.checkHandshake(session, session.walletAddress, session.walletPublicKeyHex, maxProofAgeMs);

    this.walletAddress = session.walletAddress;
    this.handshakeVerified = handshakeVerified;
    this.aesKey = await deriveSharedAesKey(this.ephemeralSecretKey, session.walletPublicKeyHex);
    return this.connectionResult();
  }

  /**
   * Дедлайн пейринга берётся из expiresAt, который relay вернул на
   * POST /sessions, — так же, как дедлайн подписи берётся из POST /requests.
   * Хардкод 120_000 был вдвое короче PAIRING_TTL_MS relay: SDK бросал
   * connection_timeout, пока ссылка ещё была вполне рабочей.
   */
  private defaultPairingTimeoutMs(): number {
    const expiry = this.expiresAt ? Date.parse(this.expiresAt) : Number.NaN;
    const ttlLeftMs = Number.isNaN(expiry) ? FALLBACK_PAIRING_TTL_MS : expiry - Date.now();
    return Math.max(0, ttlLeftMs) + PAIRING_GRACE_MS;
  }

  /**
   * Проверяет доказательство, которое relay отдаёт в GET /sessions/:sessionId.
   *
   * Провал — это не "попробуй ещё": либо relay подменил ECDH-ключ канала, либо
   * адрес. В обоих случаях дальнейшее шифрование бессмысленно, поэтому бросаем
   * сразу и НЕ помечаем ошибку как лечащуюся переподключением.
   */
  private checkHandshake(
    session: RelaySessionState,
    walletAddress: string,
    ecdhPublicKeyHex: string,
    maxAgeMs: number,
  ): boolean {
    const { identityPublicKeyHex, handshakeSignature } = session;
    if (!identityPublicKeyHex || !handshakeSignature) {
      if (this.requireHandshakeProof) {
        throw new MinterConnectError(
          'handshake_unverifiable',
          `Relay returned no handshake proof for session ${this.sessionId}. Without it the wallet address and ` +
            'the channel key are taken on trust from the relay. Upgrade the relay, or pass ' +
            'requireHandshakeProof: false to accept that risk explicitly.',
        );
      }
      return false;
    }

    const failure = verifyHandshake(
      {
        sessionId: this.sessionId,
        walletAddress,
        identityPublicKeyHex,
        ecdhPublicKeyHex,
        // Домен и время — то, что relay заявляет как подписанное. Проверяется
        // подписью и сравнением с НАШИМ expectedDomain, а не доверием.
        domain: session.dexDomain ?? '',
        issuedAt: session.handshakeIssuedAt ?? Number.NaN,
        signature: handshakeSignature,
      },
      { expectedDomain: this.expectedDomain, maxAgeMs },
    );
    if (failure) {
      throw new MinterConnectError(
        'handshake_invalid',
        `Handshake proof for session ${this.sessionId} failed verification (${failure}). ` +
          (failure === 'domain_mismatch'
            ? `The wallet signed for "${session.dexDomain ?? ''}", not for ${this.expectedDomain}. `
            : '') +
          'The relay may have tampered with the wallet address, the channel key or the domain — do not retry against it.',
        { relayError: failure },
      );
    }
    return true;
  }

  /**
   * Дедлайн берётся из expiresAt, который relay вернул на POST /requests, —
   * это единственный источник истины о TTL. Хардкод 90_000 в SDK совпадал с
   * REQUEST_TTL_MS relay ровно, поэтому SDK и relay сдавались одновременно.
   */
  private defaultSigningTimeoutMs(reqId: string): number {
    const expiry = this.requestExpiries.get(reqId);
    const ttlLeftMs = expiry !== undefined ? expiry - Date.now() : FALLBACK_REQUEST_TTL_MS;
    return Math.max(0, ttlLeftMs) + SIGNING_GRACE_MS;
  }

  private rememberRequestExpiry(reqId: string, expiresAt: string | undefined): void {
    const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isNaN(parsed)) this.requestExpiries.set(reqId, parsed);

    // Долгоживущая сессия (7 дней) может сделать много запросов; подчищаем
    // давно протухшие записи, чтобы мапа не росла бесконечно.
    const cutoff = Date.now() - REQUEST_EXPIRY_RETENTION_MS;
    for (const [id, at] of this.requestExpiries) {
      if (at < cutoff) this.requestExpiries.delete(id);
    }
  }

  /**
   * 429 в цикле поллинга не фатален: relay сам говорит, сколько ждать.
   * Фатальным он остаётся, только если ждать дольше, чем позволяет бюджет
   * всего ожидания, — иначе мы бы молча превысили заявленный timeoutMs.
   */
  private async pollWithRateLimit<T>(request: () => Promise<T>, deadline: number): Promise<T> {
    for (;;) {
      try {
        return await request();
      } catch (err) {
        if (!(err instanceof MinterConnectError) || err.code !== 'rate_limited') throw err;
        const waitMs = err.retryAfterMs ?? 1000;
        if (Date.now() + waitMs >= deadline) throw err;
        await sleep(waitMs, this.abortController.signal);
      }
    }
  }

  /** Пауза с джиттером, обрезанная дедлайном цикла. */
  private async sleepUntil(interval: number, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(applyJitter(interval), remaining), this.abortController.signal);
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new MinterConnectError('session_closed', `Session ${this.sessionId} was closed via close()`);
    }
  }

  private assertConnected(): void {
    this.assertOpen();
    if (!this.aesKey || !this.walletAddress) {
      throw new MinterConnectError(
        'session_not_connected',
        'Call waitForConnection() first — the wallet has not confirmed this session yet',
      );
    }
  }

  private get<T>(url: string): Promise<T> {
    return relayFetch<T>(url, {
      signal: this.abortController.signal,
      timeoutMs: this.requestTimeoutMs,
      authToken: this.dexToken,
    });
  }

  private post<T>(url: string, body: unknown, requestId?: string): Promise<T> {
    return relayFetch<T>(url, {
      method: 'POST',
      body,
      signal: this.abortController.signal,
      timeoutMs: this.requestTimeoutMs,
      authToken: this.dexToken,
      ...(requestId ? { requestId } : {}),
    });
  }
}
