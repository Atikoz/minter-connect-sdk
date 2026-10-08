/**
 * Конфиг клиента: manifestUrl, walletAppLink, собственный домен и тело POST /sessions.
 * Ошибки конфига должны ловиться в конструкторе, а не после того, как юзер
 * отсканировал QR и получил handshake_invalid.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { MinterConnectClient, MinterConnectError } from '../src/index.js';
import { createFetchStub, FAKE_SESSION_ID } from './helpers/fetch-stub.js';
import { RELAY_URL } from './helpers/connected.js';
import { createdSessionReply, TEST_CLIENT_CONFIG, TEST_DOMAIN, TEST_WALLET_APP_LINK } from './helpers/wallet.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function configError(config: Record<string, unknown>): MinterConnectError {
  try {
    new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG, ...config });
  } catch (err) {
    expect(err).toBeInstanceOf(MinterConnectError);
    return err as MinterConnectError;
  }
  throw new Error('expected the constructor to throw');
}

describe('конфиг', () => {
  it('домен по умолчанию — host из manifestUrl, в нижнем регистре', () => {
    expect(new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG }).domain).toBe(TEST_DOMAIN);
    expect(
      new MinterConnectClient({ ...TEST_CLIENT_CONFIG, relayUrl: RELAY_URL, manifestUrl: 'https://DEX.Test:443/m.json' })
        .domain,
    ).toBe(TEST_DOMAIN);
    expect(
      new MinterConnectClient({ ...TEST_CLIENT_CONFIG, relayUrl: RELAY_URL, manifestUrl: 'https://dex.test:8443/m.json' })
        .domain,
    ).toBe('dex.test:8443');
  });

  it('явный domain, который не совпадает с host manifestUrl, — invalid_request сразу', () => {
    expect(configError({ domain: 'other.test' }).code).toBe('invalid_request');
    expect(new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG, domain: 'DEX.test' }).domain).toBe(
      TEST_DOMAIN,
    );
  });

  it('manifestUrl только https', () => {
    expect(configError({ manifestUrl: 'http://dex.test/m.json' }).code).toBe('invalid_request');
    expect(configError({ manifestUrl: 'not a url' }).code).toBe('invalid_request');
    expect(configError({ manifestUrl: 'ftp://dex.test/m.json' }).code).toBe('invalid_request');
  });

  it('http разрешён только для localhost (dev-режим relay)', () => {
    const local = new MinterConnectClient({
      ...TEST_CLIENT_CONFIG,
      relayUrl: RELAY_URL,
      manifestUrl: 'http://localhost:5173/minter-connect-manifest.json',
    });
    expect(local.domain).toBe('localhost:5173');
    expect(configError({ manifestUrl: 'http://192.168.1.10/m.json' }).code).toBe('invalid_request');
  });

  it('walletAppLink без query/fragment', () => {
    expect(configError({ walletAppLink: `${TEST_WALLET_APP_LINK}?startapp=x` }).code).toBe('invalid_request');
    expect(configError({ walletAppLink: `${TEST_WALLET_APP_LINK}#x` }).code).toBe('invalid_request');
    expect(configError({ walletAppLink: 'MinterWalletBot' }).code).toBe('invalid_request');
  });
});

describe('createSession', () => {
  it('шлёт { dexPublicKeyHex, manifestUrl, callbackUrl? } и строит deepLink из walletAppLink', async () => {
    const stub = createFetchStub(() => ({ json: createdSessionReply(FAKE_SESSION_ID) }));
    vi.stubGlobal('fetch', stub.fetch);

    const client = new MinterConnectClient({
      relayUrl: `${RELAY_URL}/`,
      ...TEST_CLIENT_CONFIG,
      walletAppLink: `${TEST_WALLET_APP_LINK}/`,
    });
    const session = await client.createSession({ callbackUrl: 'https://dex.test/hooks/minter' });

    expect(stub.calls[0]!.url).toBe(`${RELAY_URL}/sessions`);
    expect(stub.calls[0]!.body).toEqual({
      dexPublicKeyHex: expect.stringMatching(/^[0-9a-f]{66}$/),
      manifestUrl: TEST_CLIENT_CONFIG.manifestUrl,
      callbackUrl: 'https://dex.test/hooks/minter',
    });
    expect(session.deepLink).toBe(`${TEST_WALLET_APP_LINK}?startapp=connect_${FAKE_SESSION_ID}`);
    // dexToken не попадает в ссылку никогда.
    expect(session.deepLink).not.toContain(createdSessionReply(FAKE_SESSION_ID).dexToken as string);
  });

  it('без callbackUrl поле не отправляется вообще (relay отвергает лишние/пустые)', async () => {
    const stub = createFetchStub(() => ({ json: createdSessionReply(FAKE_SESSION_ID) }));
    vi.stubGlobal('fetch', stub.fetch);

    await new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG }).createSession();
    expect(Object.keys(stub.calls[0]!.body as object).sort()).toEqual(['dexPublicKeyHex', 'manifestUrl']);
  });

  it('relay без dexToken в ответе (старый) -> relay_error, а не сессия, которая никогда не заработает', async () => {
    const stub = createFetchStub(() => ({ json: { sessionId: FAKE_SESSION_ID, expiresAt: null } }));
    vi.stubGlobal('fetch', stub.fetch);

    const err = (await new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG })
      .createSession()
      .catch((e: unknown) => e)) as MinterConnectError;
    expect(err.code).toBe('relay_error');
    expect(err.message).toMatch(/dexToken/);
  });
});
