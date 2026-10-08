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

/** Те, що relay віддає в GET /sessions/:sessionId. */
interface RelaySessionState {
  status: SessionStatus;
  /** Домен, який гаманець підписав. Заявка relay — звіряється з НАШИМ доменом. */
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
  /** Bearer-токен сесії з POST /sessions. */
  dexToken: string;
  /** Власний домен сайту з конфігу клієнта. */
  expectedDomain: string;
  /** ISO-8601 дедлайн pairing'у з POST /sessions. */
  expiresAt: string | null;
  requestTimeoutMs?: number;
  requireHandshakeProof?: boolean;
}

export interface WaitForConnectionOptions {
  /** Стартовий інтервал поллінгу. Далі росте до maxIntervalMs. */
  intervalMs?: number;
  /** Стеля інтервалу поллінгу. */
  maxIntervalMs?: number;
  /** Бюджет усього очікування. Після нього — `connection_timeout`. */
  timeoutMs?: number;
}

export interface WaitForSignatureOptions {
  pollIntervalMs?: number;
  maxIntervalMs?: number;
  /**
   * Бюджет очікування. За замовчуванням виводиться з `expiresAt`, який relay
   * повернув на POST /requests, плюс запас на кілька інтервалів поллінгу.
   */
  timeoutMs?: number;
}

export interface RequestTransactionOptions {
  /** X-Request-Id для наскрізного трасування relay -> воркер -> вебхук. */
  requestId?: string;
}

/**
 * Запас понад TTL запиту. Без нього SDK здається рівно в ту мить, коли запит
 * протухає: гонка вирішується як `signing_timeout` (нічого не зрозуміло)
 * замість `signing_expired` (зрозуміло: гаманець не встиг).
 */
const SIGNING_GRACE_MS = 15_000;

/** Фолбек, якщо relay не повернув expiresAt: дефолтний REQUEST_TTL_MS relay. */
const FALLBACK_REQUEST_TTL_MS = 90_000;

/**
 * Запас понад дедлайн pairing'у — рівно та сама логіка, що й SIGNING_GRACE_MS:
 * дає relay встигнути перевести сесію в `expired`, щоб користувач побачив
 * "час вийшов", а не безадресний `connection_timeout`.
 */
const PAIRING_GRACE_MS = 10_000;

/** Фолбек, якщо relay не повернув expiresAt на POST /sessions: його PAIRING_TTL_MS. */
const FALLBACK_PAIRING_TTL_MS = 300_000;

/**
 * Вік підпису handshake, з яким його приймає waitForConnection(). Гаманець
 * підписує в момент підтвердження, а pairing живе 5 хв — 10 хв дають запас на
 * повільний поллінг, але не дають підсунути старий підпис.
 */
const CONNECT_PROOF_MAX_AGE_MS = 10 * 60_000;

/** Скільки тримати expiresAt завершених запитів, перш ніж прибрати з мапи. */
const REQUEST_EXPIRY_RETENTION_MS = 10 * 60_000;

/**
 * Один pairing-сеанс із конкретним гаманцем юзера. Отримується через
 * MinterConnectClient.createSession() — ніколи не створюється напряму.
 *
 * Уся крипто-механіка (ECDH, AES-GCM, identity-vs-ecdh ключі) захована тут.
 * Інтегратору не потрібно знати про жоден із цих деталей.
 */
export class MinterConnectSession {
  readonly sessionId: string;
  readonly deepLink: string;
  walletAddress: string | null = null;
  /** Чи перевірено доказ handshake самостійно. Заповнюється у waitForConnection(). */
  handshakeVerified = false;
  /**
   * ISO-8601 строк життя. До підтвердження — дедлайн pairing'у (relay дає
   * 5 хвилин), після waitForConnection() — дедлайн самої сесії (7 днів).
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
  /** reqId -> момент протухання (ms), щоб waitForSignature знав реальний дедлайн. */
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

  /** true після close(). Будь-який виклик на закритій сесії дасть `session_closed`. */
  get isClosed(): boolean {
    return this.abortController.signal.aborted;
  }

  /** Чи готова сесія підписувати: handshake пройдено і ключ каналу виведено. */
  get isConnected(): boolean {
    return this.aesKey !== null && this.walletAddress !== null;
  }

  /**
   * Стан для збереження між запусками DEX. Relay тримає підтверджену сесію
   * 7 днів, але ephemeral-ключ живе лише в пам'яті цього інстанса — без
   * serialize() перезавантаження сторінки вимагає нового пейрінгу, і цей TTL
   * обслуговує тільки сторону гаманця.
   *
   * Повертає ДВА СЕКРЕТИ (ephemeral-ключ і dexToken, див. SerializedSession):
   * зберігайте лише на сервері або зашифрованими. Відновлення — через
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
   * Один запит до relay замість циклу поллінгу: підтягує актуальний стан
   * відновленої сесії. Повертає `null`, якщо гаманець ще не підтвердив
   * підключення, — тоді далі йде звичайний waitForConnection().
   *
   * Викликається з restoreSession(); окремо потрібен рідко.
   *
   * Свіжість підпису handshake тут НЕ перевіряється: сесію могли підтвердити
   * до 7 днів тому, і з перевіркою "не старше 10 хв" відновлення падало б
   * завжди. Домен, адреса і підпис перевіряються як завжди.
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
   * Припиняє всі цикли поллінгу цієї сесії й перериває запити, що вже в польоті.
   * Викликайте, коли користувач пішов зі сторінки або скасував операцію:
   * інакше waitForConnection() продовжить довбити relay до свого таймауту.
   *
   * Сесію на relay це НЕ відкликає (відкликати може лише гаманець) — це
   * локальне звільнення ресурсів. Ідемпотентний.
   */
  close(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  /** Аліас до close() для `await using` / звичного dispose-найменування. */
  dispose(): void {
    this.close();
  }

  /** Поллить relay, поки юзер не підтвердить конект у гаманці (або поки не вийде час). */
  async waitForConnection(options: WaitForConnectionOptions = {}): Promise<ConnectionResult> {
    const { intervalMs = 2000, maxIntervalMs = 10_000 } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultPairingTimeoutMs();
    this.assertOpen();

    // Відновлена сесія вже перевірена в resume(). Повторна перевірка тут
    // ішла б із вікном 10 хв і відкидала б handshake, підписаний учора.
    if (this.isConnected) return this.connectionResult();

    const deadline = Date.now() + timeoutMs;
    let interval = intervalMs;

    while (Date.now() < deadline) {
      const session = await this.pollWithRateLimit(() => this.fetchSessionState(), deadline);

      this.expiresAt = session.expiresAt ?? this.expiresAt;

      // Термінальні статуси. Раніше цикл їх ігнорував і крутився до кінця
      // timeoutMs, після чого кидав connection_timeout — тобто повідомляв
      // НЕПРАВДИВУ причину: користувач не "не встиг", він відмовив або
      // сесія вже мертва, і чекати не було сенсу з першої ж ітерації.
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
   * Просить гаманець підписати переказ і чекає результат. Це найпростіший
   * спосіб використання SDK — для більшості інтеграторів іншого й не треба.
   *
   * Повертає signedTxHex. У мережу його відправляє САЙТ (Gate/Node API,
   * `send_transaction`): ні relay, ні гаманець транзакцію не транслюють.
   */
  async sendTransaction(
    params: SendTransactionParams,
    options: WaitForSignatureOptions & RequestTransactionOptions = {},
  ): Promise<string> {
    const reqId = await this.requestTransaction(params, options);
    return this.waitForSignature(reqId, options);
  }

  /**
   * Створює запит на підпис, повертає reqId одразу — для інтеграторів, яким
   * треба надіслати кілька транзакцій і чекати їх окремо/паралельно.
   *
   * Некоректні params дають `invalid_request` ДО будь-якого запиту в мережу.
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
   * Чекає результат конкретного reqId, отриманого від requestTransaction().
   * Повертає signedTxHex; відмова гаманця — `signing_rejected`,
   * `wallet_bad_request` або `wallet_signing_failed`.
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
          // Relay також переводить pending-запити в 'rejected' без результату,
          // коли гаманець відкликає сесію, — це теж wallet_bad_request.
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
   * Внутрішнє
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

  /** `undefined` — результату немає або він не розшифровується цим ключем. */
  private async tryDecrypt(encrypted: EncryptedPayload | null | undefined): Promise<unknown> {
    if (!encrypted) return undefined;
    try {
      return await decryptPayload<unknown>(this.aesKey!, encrypted);
    } catch (err) {
      // Відсутній Web Crypto — проблема середовища, а не результату.
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
   * Спільний шлях для waitForConnection() і resume(): перевірити доказ,
   * запам'ятати адресу, вивести ключ каналу. `null` — сесія ще не connected.
   *
   * Доказ перевіряється ЩОРАЗУ, зокрема й після відновлення зі сховища. Тому
   * персистентність нічого не послаблює: збереженого `handshakeVerified` не
   * існує, є лише свіжий підпис гаманця, перевірений заново.
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
   * Дедлайн пейрінгу береться з expiresAt, який relay повернув на
   * POST /sessions, — так само, як дедлайн підпису береться з POST /requests.
   * Хардкод 120_000 був удвічі коротший за PAIRING_TTL_MS relay: SDK кидав
   * connection_timeout, поки посилання ще було цілком робоче.
   */
  private defaultPairingTimeoutMs(): number {
    const expiry = this.expiresAt ? Date.parse(this.expiresAt) : Number.NaN;
    const ttlLeftMs = Number.isNaN(expiry) ? FALLBACK_PAIRING_TTL_MS : expiry - Date.now();
    return Math.max(0, ttlLeftMs) + PAIRING_GRACE_MS;
  }

  /**
   * Перевіряє доказ, який relay віддає в GET /sessions/:sessionId.
   *
   * Провал — це не "спробуй ще": або relay підмінив ECDH-ключ каналу, або
   * адресу. В обох випадках подальше шифрування безглузде, тому кидаємо
   * одразу і НЕ позначаємо помилку як таку, що лікується перепідключенням.
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
        // Домен і час — те, що relay заявляє як підписане. Перевіряється
        // підписом і порівнянням з НАШИМ expectedDomain, а не довірою.
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
   * Дедлайн береться з expiresAt, який relay повернув на POST /requests, —
   * це єдине джерело істини про TTL. Хардкод 90_000 у SDK збігався з
   * REQUEST_TTL_MS relay рівно, тож SDK і relay здавались одночасно.
   */
  private defaultSigningTimeoutMs(reqId: string): number {
    const expiry = this.requestExpiries.get(reqId);
    const ttlLeftMs = expiry !== undefined ? expiry - Date.now() : FALLBACK_REQUEST_TTL_MS;
    return Math.max(0, ttlLeftMs) + SIGNING_GRACE_MS;
  }

  private rememberRequestExpiry(reqId: string, expiresAt: string | undefined): void {
    const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isNaN(parsed)) this.requestExpiries.set(reqId, parsed);

    // Довгоживуча сесія (7 днів) може зробити багато запитів; підчищаємо
    // давно протухлі записи, щоб мапа не росла нескінченно.
    const cutoff = Date.now() - REQUEST_EXPIRY_RETENTION_MS;
    for (const [id, at] of this.requestExpiries) {
      if (at < cutoff) this.requestExpiries.delete(id);
    }
  }

  /**
   * 429 у циклі поллінгу не фатальний: relay сам каже, скільки чекати.
   * Фатальним він лишається тільки якщо чекати довше, ніж дозволяє бюджет
   * усього очікування, — інакше ми б мовчки перевищили заявлений timeoutMs.
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

  /** Пауза з джитером, обрізана дедлайном циклу. */
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
