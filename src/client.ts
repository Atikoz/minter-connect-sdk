import { generateEphemeralKeyPair, secretKeyFromHex } from './crypto.js';
import { normalizeDomain } from './handshake.js';
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
 * (relayUrl/manifestUrl/walletAppLink), а кожен виклик createSession()
 * дає окрему MinterConnectSession для одного конкретного юзера/гаманця.
 */
export class MinterConnectClient {
  private readonly relayUrl: string;
  private readonly walletAppLink: string;
  /** Власний домен сайту, з яким звіряється підпис handshake. */
  readonly domain: string;

  constructor(private config: MinterConnectConfig) {
    // Кінцевий слеш у relayUrl дав би '//sessions'. Fastify зазвичай це
    // переживає, а проксі перед ним — не завжди.
    this.relayUrl = config.relayUrl.replace(/\/+$/, '');
    this.walletAppLink = parseWalletAppLink(config.walletAppLink);
    const manifestHost = parseManifestHost(config.manifestUrl);

    // Гаманець підписує host із manifest.url, а relay вимагає, щоб він
    // дорівнював host manifestUrl. Тож інший domain не пройде НІКОЛИ —
    // краще сказати про це тут, ніж handshake_invalid після сканування QR.
    this.domain = normalizeDomain(config.domain ?? manifestHost);
    if (this.domain !== manifestHost) {
      throw new MinterConnectError(
        'invalid_request',
        `config.domain "${this.domain}" differs from the manifestUrl host "${manifestHost}". The wallet signs the ` +
          'manifest host, so the handshake could never verify.',
      );
    }
  }

  async createSession(options: CreateSessionOptions = {}): Promise<MinterConnectSession> {
    const ephemeral = generateEphemeralKeyPair();
    const callbackUrl = options.callbackUrl ?? this.config.callbackUrl;

    const { sessionId, dexToken, expiresAt } = await relayFetch<{
      sessionId: string;
      dexToken: string;
      expiresAt: string | null;
    }>(
      `${this.relayUrl}/sessions`,
      {
        method: 'POST',
        body: {
          dexPublicKeyHex: ephemeral.publicKeyHex,
          manifestUrl: this.config.manifestUrl,
          // Поле додається ТІЛЬКИ якщо задане: у relay additionalProperties:
          // false і removeAdditional вимкнено, тож `callbackUrl: undefined`
          // після JSON.stringify зникне, а от порожній рядок дав би 400.
          ...(callbackUrl ? { callbackUrl } : {}),
        },
        timeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
    );

    if (typeof dexToken !== 'string' || !DEX_TOKEN_RE.test(dexToken)) {
      // Relay без dexToken — старий формат: жоден наступний запит не пройде.
      throw new MinterConnectError(
        'relay_error',
        'Relay did not return a dexToken for the new session. It is probably older than this SDK (2.x needs ' +
          'the manifest/dexToken relay API).',
      );
    }

    return this.buildSession(sessionId, ephemeral.secretKey, dexToken, expiresAt ?? null);
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

    const session = this.buildSession(
      state.sessionId,
      secretKeyFromHex(state.ephemeralSecretKeyHex),
      state.dexToken,
      null,
    );
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

  private buildSession(sessionId: string, ephemeralSecretKey: Uint8Array, dexToken: string, expiresAt: string | null) {
    return new MinterConnectSession({
      relayUrl: this.relayUrl,
      sessionId,
      // docs/API.md → «Посилання на підключення». dexToken сюди не потрапляє.
      deepLink: `${this.walletAppLink}?startapp=connect_${sessionId}`,
      ephemeralSecretKey,
      dexToken,
      expectedDomain: this.domain,
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
  const { v, sessionId, ephemeralSecretKeyHex, dexToken } = (state ?? {}) as unknown as Partial<Record<string, unknown>>;
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
}

/** Формат, який relay приймає в `Authorization: Bearer`. */
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
  // http — лише для локальної розробки: relay у дев-режимі
  // (WEBHOOK_ALLOW_PRIVATE_NETWORK=true) приймає http://localhost, а в
  // проді відхиляє все, крім https.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new MinterConnectError(
      'invalid_request',
      'config.manifestUrl must be https (http is accepted only for localhost during development)',
    );
  }
  // URL.host уже в нижньому регістрі й без стандартного порту — рівно те,
  // що гаманець підписує як domain.
  return url.host;
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
