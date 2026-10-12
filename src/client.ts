import { generateEphemeralKeyPair, secretKeyFromHex } from './crypto.js';
import { normalizeDomain } from './handshake.js';
import { relayFetch, DEFAULT_REQUEST_TIMEOUT_MS } from './http.js';
import { MinterConnectSession } from './session.js';
import { MinterConnectError, type MinterConnectConfig, type SerializedSession } from './types.js';

export interface CreateSessionOptions {
  /**
   * Вебхук именно для этой сессии; перекрывает callbackUrl из конфига клиента.
   * Должен быть https и не вести в приватную сеть — иначе relay ответит
   * 400 `invalid_callback_url` (SDK бросит `invalid_request` с причиной).
   */
  callbackUrl?: string;
  /** X-Request-Id для сквозной трассировки в логах relay. */
  requestId?: string;
}

/**
 * Точка входа в SDK. Один инстанс на всё приложение DEX — держит конфиг
 * (relayUrl/manifestUrl/walletAppLink), а каждый вызов createSession()
 * даёт отдельную MinterConnectSession для одного конкретного юзера/кошелька.
 */
export class MinterConnectClient {
  private readonly relayUrl: string;
  private readonly walletAppLink: string;
  /** Собственный домен сайта, с которым сверяется подпись handshake. */
  readonly domain: string;

  constructor(private config: MinterConnectConfig) {
    // Конечный слеш в relayUrl дал бы '//sessions': прокси перед relay не всегда это переживают.
    this.relayUrl = parseRelayUrl(config.relayUrl);
    this.walletAppLink = parseWalletAppLink(config.walletAppLink);
    const manifestHost = parseManifestHost(config.manifestUrl);

    // Кошелёк подписывает host из manifest.url, а relay требует, чтобы он
    // равнялся host manifestUrl. Значит, другой domain не пройдёт НИКОГДА —
    // лучше сказать об этом здесь, чем handshake_invalid после сканирования QR.
    this.domain = normalizeDomain(config.domain ?? manifestHost);
    if (this.domain !== manifestHost) {
      throw new MinterConnectError(
        'invalid_request',
        `config.domain "${this.domain}" differs from the manifestUrl host "${manifestHost}". The wallet signs the ` +
          'manifest host, so the handshake could never verify.',
      );
    }

    if (config.requireHandshakeProof === false) warnHandshakeOptOutDeprecated();
  }

  async createSession(options: CreateSessionOptions = {}): Promise<MinterConnectSession> {
    const ephemeral = generateEphemeralKeyPair();
    const callbackUrl = options.callbackUrl ?? this.config.callbackUrl;

    const { sessionId, dexToken, webhookSecret, expiresAt } = await relayFetch<{
      sessionId: string;
      dexToken: string;
      webhookSecret?: string;
      expiresAt: string | null;
    }>(
      `${this.relayUrl}/sessions`,
      {
        method: 'POST',
        body: {
          dexPublicKeyHex: ephemeral.publicKeyHex,
          manifestUrl: this.config.manifestUrl,
          // Поле добавляется ТОЛЬКО если задано: в relay additionalProperties:
          // false и removeAdditional выключен, поэтому `callbackUrl: undefined`
          // после JSON.stringify исчезнет, а вот пустая строка дала бы 400.
          ...(callbackUrl ? { callbackUrl } : {}),
        },
        timeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        requestId: options.requestId,
      },
    );

    if (typeof sessionId !== 'string' || !sessionId) {
      throw new MinterConnectError('relay_error', 'Relay created a session but returned no sessionId');
    }
    if (typeof dexToken !== 'string' || !DEX_TOKEN_RE.test(dexToken)) {
      // Relay без dexToken — старый формат: ни один следующий запрос не пройдёт.
      throw new MinterConnectError(
        'relay_error',
        'Relay did not return a dexToken for the new session. It is probably older than this SDK (2.x needs ' +
          'the manifest/dexToken relay API).',
      );
    }

    return this.buildSession(sessionId, ephemeral.secretKey, dexToken, expiresAt ?? null, webhookSecret);
  }

  /**
   * Восстанавливает сессию из состояния, сохранённого через session.serialize().
   *
   * Relay держит подтверждённую сессию 7 дней и в GET /sessions/:id отдаёт всё
   * нужное, включая доказательство handshake, — поэтому восстановление не доверяет
   * хранилищу: адрес и ключ канала берутся из relay, и доказательство проверяется
   * заново, как при первом подключении.
   *
   * Бросает `session_revoked` / `session_expired` / `session_not_found`, если
   * сессии больше нет, — то есть именно те коды, на которые интегратор уже реагирует
   * через err.requiresReconnect.
   *
   * Возвращённая сессия готова подписывать, ЕСЛИ кошелёк успел подтвердить
   * подключение до перезапуска. Иначе она остаётся в состоянии pending
   * (`isConnected === false`) — тогда показывайте deepLink и вызывайте
   * waitForConnection() как обычно.
   */
  async restoreSession(state: SerializedSession): Promise<MinterConnectSession> {
    assertSerializedSession(state);

    const session = this.buildSession(
      state.sessionId,
      secretKeyFromHex(state.ephemeralSecretKeyHex),
      state.dexToken,
      null,
      state.webhookSecret,
    );
    try {
      await session.resume();
    } catch (err) {
      // Мёртвую сессию не оставляем с живым циклом поллинга: интегратор в
      // catch-ветке обычно сразу создаёт новую и об этой уже не вспомнит.
      session.close();
      throw err;
    }
    return session;
  }

  private buildSession(
    sessionId: string,
    ephemeralSecretKey: Uint8Array,
    dexToken: string,
    expiresAt: string | null,
    webhookSecret?: string,
  ) {
    return new MinterConnectSession({
      relayUrl: this.relayUrl,
      sessionId,
      // docs/API.md → «Посилання на підключення». dexToken сюда не попадает.
      deepLink: `${this.walletAppLink}?startapp=connect_${sessionId}`,
      ephemeralSecretKey,
      dexToken,
      // Пустую строку или не-строку от relay секретом не считаем.
      webhookSecret: typeof webhookSecret === 'string' && webhookSecret ? webhookSecret : undefined,
      expectedDomain: this.domain,
      expiresAt,
      requestTimeoutMs: this.config.requestTimeoutMs,
      requireHandshakeProof: this.config.requireHandshakeProof,
    });
  }
}

/**
 * Состояние приходит из хранилища, а не из кода, поэтому оно может быть чем угодно:
 * обрезанный JSON, запись от более старой версии формата, чужой объект. Проверка
 * формы здесь даёт `invalid_request` с понятным текстом вместо падения
 * где-то внутри крипты.
 */
function assertSerializedSession(state: SerializedSession): void {
  const { v, sessionId, ephemeralSecretKeyHex, dexToken, webhookSecret } = (state ?? {}) as unknown as Partial<
    Record<string, unknown>
  >;
  if (v === 1) {
    throw new MinterConnectError(
      'invalid_request',
      'Serialized session v1 cannot be restored: the relay closed pre-dexToken sessions on migration. ' +
        'Discard it and create a new connection.',
    );
  }
  if (v !== 2) {
    throw new MinterConnectError('invalid_request', `Unsupported serialized session version: ${String(v)} (expected 2)`);
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new MinterConnectError('invalid_request', 'Serialized session is missing sessionId');
  }
  if (typeof ephemeralSecretKeyHex !== 'string' || !ephemeralSecretKeyHex) {
    throw new MinterConnectError('invalid_request', 'Serialized session is missing ephemeralSecretKeyHex');
  }
  if (typeof dexToken !== 'string' || !DEX_TOKEN_RE.test(dexToken)) {
    throw new MinterConnectError('invalid_request', 'Serialized session is missing a valid dexToken');
  }
  if (webhookSecret !== undefined && (typeof webhookSecret !== 'string' || !webhookSecret)) {
    throw new MinterConnectError('invalid_request', 'Serialized session has an invalid webhookSecret');
  }
}

let handshakeOptOutWarned = false;

/**
 * Один раз на процесс/страницу: клиентов обычно создают при каждом запросе, и
 * предупреждение на каждый вызов забило бы логи.
 */
function warnHandshakeOptOutDeprecated(): void {
  if (handshakeOptOutWarned) return;
  handshakeOptOutWarned = true;
  console.warn(
    '[minter-connect-sdk] requireHandshakeProof: false is deprecated since 2.1.0 and will be removed in 3.0. ' +
      'It disables verification of the wallet handshake, so the relay could substitute the wallet address or ' +
      'the channel key. Remove the option: current relays always return the proof.',
  );
}

/** Формат, который relay принимает в `Authorization: Bearer`. */
const DEX_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function parseManifestHost(manifestUrl: string): string {
  let url: URL;
  try {
    url = new URL(manifestUrl);
  } catch (cause) {
    throw new MinterConnectError('invalid_request', `config.manifestUrl is not a valid URL: ${String(manifestUrl)}`, {
      cause,
    });
  }
  // http — только для локальной разработки: relay в dev-режиме
  // (WEBHOOK_ALLOW_PRIVATE_NETWORK=true) принимает http://localhost, а в
  // проде отклоняет всё, кроме https.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new MinterConnectError(
      'invalid_request',
      'config.manifestUrl must be https (http is accepted only for localhost during development)',
    );
  }
  // URL.host уже в нижнем регистре и без стандартного порта — ровно то,
  // что кошелёк подписывает как domain.
  return url.host;
}

function parseRelayUrl(relayUrl: string): string {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch (cause) {
    throw new MinterConnectError('invalid_request', `config.relayUrl is not a valid URL: ${String(relayUrl)}`, { cause });
  }
  // http допустим: relay на соседнем хосте во внутренней сети или localhost в разработке.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MinterConnectError('invalid_request', 'config.relayUrl must be an http(s) URL');
  }
  if (url.search || url.hash) {
    throw new MinterConnectError('invalid_request', 'config.relayUrl must not contain a query or fragment');
  }
  return relayUrl.replace(/\/+$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

function parseWalletAppLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch (cause) {
    throw new MinterConnectError(
      'invalid_request',
      `config.walletAppLink is not a valid URL: ${String(link)}. Use the Mini App Direct Link, e.g. https://t.me/MinterWalletBot/app`,
      { cause },
    );
  }
  if (url.search || url.hash) {
    throw new MinterConnectError(
      'invalid_request',
      'config.walletAppLink must not contain a query or fragment: the SDK appends ?startapp=connect_<sessionId> itself',
    );
  }
  return link.replace(/\/+$/, '');
}
