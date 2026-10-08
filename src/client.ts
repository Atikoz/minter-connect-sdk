import { generateEphemeralKeyPair, secretKeyFromHex } from './crypto.js';
import { relayFetch, DEFAULT_REQUEST_TIMEOUT_MS } from './http.js';
import { MinterConnectSession } from './session.js';
import { MinterConnectError, type MinterConnectConfig, type SerializedSession } from './types.js';

export interface CreateSessionOptions {
  /**
   * Вебхук саме для цієї сесії; перекриває callbackUrl з конфігу клієнта.
   * Має бути https і не вести у приватну мережу — інакше relay відповість
   * 400 `invalid_callback_url` (SDK кине `invalid_request` із причиною).
   */
  callbackUrl?: string;
  /** X-Request-Id для наскрізного трасування у логах relay. */
  requestId?: string;
}

/**
 * Точка входу в SDK. Один інстанс на весь застосунок DEX — тримає конфіг
 * (relayUrl/dexName/walletBotUsername), а кожен виклик createSession()
 * дає окрему MinterConnectSession для одного конкретного юзера/гаманця.
 */
export class MinterConnectClient {
  private readonly relayUrl: string;

  constructor(private config: MinterConnectConfig) {
    // Кінцевий слеш у relayUrl дав би '//sessions'. Fastify зазвичай це
    // переживає, а проксі перед ним — не завжди.
    this.relayUrl = config.relayUrl.replace(/\/+$/, '');
  }

  async createSession(options: CreateSessionOptions = {}): Promise<MinterConnectSession> {
    const ephemeral = generateEphemeralKeyPair();
    const callbackUrl = options.callbackUrl ?? this.config.callbackUrl;

    const { sessionId, expiresAt } = await relayFetch<{ sessionId: string; expiresAt: string | null }>(
      `${this.relayUrl}/sessions`,
      {
        method: 'POST',
        body: {
          dexPublicKeyHex: ephemeral.publicKeyHex,
          dexName: this.config.dexName,
          // Поле додається ТІЛЬКИ якщо задане: у relay additionalProperties:
          // false і removeAdditional вимкнено, тож `callbackUrl: undefined`
          // після JSON.stringify зникне, а от порожній рядок дав би 400.
          ...(callbackUrl ? { callbackUrl } : {}),
        },
        timeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
    );

    return this.buildSession(sessionId, ephemeral.secretKey, expiresAt ?? null);
  }

  /**
   * Відновлює сесію зі стану, збереженого через session.serialize().
   *
   * Relay тримає підтверджену сесію 7 днів і в GET /sessions/:id віддає все
   * потрібне, включно з доказом handshake, — тож відновлення не довіряє
   * сховищу: адреса й ключ каналу беруться з relay і доказ перевіряється
   * заново, як при першому підключенні.
   *
   * Кидає `session_revoked` / `session_expired` / `session_not_found`, якщо
   * сесії більше немає, — тобто саме ті коди, на які інтегратор уже реагує
   * через err.requiresReconnect.
   *
   * Повернена сесія готова підписувати, ЯКЩО гаманець встиг підтвердити
   * підключення до перезапуску. Інакше вона лишається у стані pending
   * (`isConnected === false`) — тоді показуйте deepLink і викликайте
   * waitForConnection() як завжди.
   */
  async restoreSession(state: SerializedSession): Promise<MinterConnectSession> {
    assertSerializedSession(state);

    const session = this.buildSession(state.sessionId, secretKeyFromHex(state.ephemeralSecretKeyHex), null);
    try {
      await session.resume();
    } catch (err) {
      // Мертву сесію не лишаємо з живим циклом поллінгу: інтегратор у
      // catch-гілці зазвичай одразу створює нову і про цю вже не згадає.
      session.close();
      throw err;
    }
    return session;
  }

  private buildSession(sessionId: string, ephemeralSecretKey: Uint8Array, expiresAt: string | null) {
    return new MinterConnectSession({
      relayUrl: this.relayUrl,
      sessionId,
      deepLink: `https://t.me/${this.config.walletBotUsername}/app?startapp=connect_${sessionId}`,
      ephemeralSecretKey,
      expiresAt,
      ...(this.config.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.config.requestTimeoutMs } : {}),
      ...(this.config.requireHandshakeProof !== undefined
        ? { requireHandshakeProof: this.config.requireHandshakeProof }
        : {}),
    });
  }
}

/**
 * Стан приходить зі сховища, а не з коду, тож він може бути будь-чим:
 * обрізаний JSON, запис від старішої версії формату, чужий об'єкт. Перевірка
 * форми тут дає `invalid_request` із зрозумілим текстом замість падіння
 * десь усередині крипти.
 */
function assertSerializedSession(state: SerializedSession): void {
  const { v, sessionId, ephemeralSecretKeyHex } = (state ?? {}) as Partial<SerializedSession>;
  if (v !== 1) {
    throw new MinterConnectError('invalid_request', `Unsupported serialized session version: ${String(v)} (expected 1)`);
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new MinterConnectError('invalid_request', 'Serialized session is missing sessionId');
  }
  if (typeof ephemeralSecretKeyHex !== 'string' || !ephemeralSecretKeyHex) {
    throw new MinterConnectError('invalid_request', 'Serialized session is missing ephemeralSecretKeyHex');
  }
}
