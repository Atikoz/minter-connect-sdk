/**
 * Піднімає сесію SDK до стану "connected" поверх стабу fetch, щоб тести
 * помилок і поллінгу починались із того ж місця, з якого починає інтегратор.
 */

import { vi } from 'vitest';
import { MinterConnectClient } from '../../src/client.js';
import type { MinterConnectSession } from '../../src/session.js';
import { deriveSharedAesKey } from '../../src/crypto.js';
import { createFetchStub, FAKE_SESSION_ID, type StubCall, type StubHandler } from './fetch-stub.js';
import { connectedSessionPayload, createSimulatedWallet, type SimulatedWallet } from './wallet.js';

export const RELAY_URL = 'https://relay.test';

export interface ConnectedFixture {
  session: MinterConnectSession;
  wallet: SimulatedWallet;
  /** AES-ключ сторони гаманця — щоб перевіряти, що SDK зашифрував читабельно. */
  walletAesKey: CryptoKey;
  calls: StubCall[];
}

/**
 * `handler` обробляє все, що йде ПІСЛЯ успішного handshake. Сам handshake
 * (POST /sessions + один GET зі статусом connected) стаб закриває сам.
 */
export async function connectSession(handler: StubHandler): Promise<ConnectedFixture> {
  const wallet = createSimulatedWallet();
  const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
  let dexPublicKeyHex = '';
  let connected = false;

  const stub = createFetchStub(async (call, index) => {
    if (!connected) {
      if (call.method === 'POST' && call.url === `${RELAY_URL}/sessions`) {
        dexPublicKeyHex = (call.body as { dexPublicKeyHex: string }).dexPublicKeyHex;
        return { json: { sessionId: FAKE_SESSION_ID, expiresAt: new Date(Date.now() + 300_000).toISOString() } };
      }
      if (call.method === 'GET' && call.url === `${RELAY_URL}/sessions/${FAKE_SESSION_ID}`) {
        connected = true;
        return { json: connectedSessionPayload(wallet, FAKE_SESSION_ID, { dexPublicKeyHex, expiresAt: sessionExpiresAt }) };
      }
    }
    return handler(call, index);
  });

  vi.stubGlobal('fetch', stub.fetch);

  const client = new MinterConnectClient({
    relayUrl: RELAY_URL,
    dexName: 'Test DEX',
    walletBotUsername: 'minter_wallet_bot',
  });

  const session = await client.createSession();
  await session.waitForConnection({ intervalMs: 1, timeoutMs: 2000 });

  const walletAesKey = await deriveSharedAesKey(wallet.ecdh.secretKey, dexPublicKeyHex);
  return { session, wallet, walletAesKey, calls: stub.calls };
}

/** Стандартна відповідь relay на POST /sessions/:id/requests. */
export function pendingRequestReply(reqId: string, ttlMs = 90_000) {
  return { json: { reqId, status: 'pending', expiresAt: new Date(Date.now() + ttlMs).toISOString() } };
}
