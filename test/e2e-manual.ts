/**
 * РУЧНИЙ e2e-тест проти живого relay. У npm-пакет не потрапляє (rootDir=src).
 *
 *   cd ../minterWallet/minter-backend
 *   docker compose up -d && npm run migrate:up && npm run dev
 *   cd -  &&  npm run test:e2e
 *
 * Relay має бути в дев-режимі (WEBHOOK_ALLOW_PRIVATE_NETWORK=true): manifest
 * цей скрипт роздає сам з http://localhost:<MANIFEST_PORT>, а relay у проді
 * ходить лише на публічні https-адреси.
 *
 * Змінні: RELAY_URL (за замовчуванням http://localhost:3000),
 *         MANIFEST_PORT (за замовчуванням 5179),
 *         CALLBACK_URL (не обов'язково).
 *
 * Сценарії: щасливий шлях, відмова гаманця з кодом, відновлення сесії з
 * dexToken і відкликана сесія.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MinterConnectClient, MinterConnectError, type MinterConnectSession } from '../src/index.js';
import { deriveSharedAesKey, encryptPayload, decryptPayload, type EncryptedPayload } from '../src/crypto.js';
import { canonicalHandshakeMessage, canonicalRevokeMessage, createSimulatedWallet, signMessage, type SimulatedWallet } from './helpers/wallet.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:3000';
const MANIFEST_PORT = Number(process.env.MANIFEST_PORT ?? 5179);
const CALLBACK_URL = process.env.CALLBACK_URL;
const SIGNED_TX = 'f8a0deadbeefcafe';
const TX = { to: `Mx${'11'.repeat(20)}`, amount: '1.5', coin: 'BIP' };

/* --------------------------- manifest сайту --------------------------- */

const origin = `http://localhost:${MANIFEST_PORT}`;
const manifestServer = createServer((req, res) => {
  if (req.url !== '/minter-connect-manifest.json') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ url: origin, name: 'Test DEX via SDK', iconUrl: `${origin}/icon.png` }));
});
await new Promise<void>((resolve) => manifestServer.listen(MANIFEST_PORT, '127.0.0.1', resolve));
console.log('[dex] manifest on', `${origin} (port ${(manifestServer.address() as AddressInfo).port})`);

const client = new MinterConnectClient({
  relayUrl: RELAY_URL,
  manifestUrl: `${origin}/minter-connect-manifest.json`,
  walletAppLink: 'https://t.me/MinterWalletBot/app',
  ...(CALLBACK_URL ? { callbackUrl: CALLBACK_URL } : {}),
});

/** Стан симульованого гаманця для однієї сесії. */
interface WalletSide {
  wallet: SimulatedWallet;
  sessionId: string;
  aesKey: CryptoKey;
}

async function connect(): Promise<{ session: MinterConnectSession; side: WalletSide }> {
  const wallet = createSimulatedWallet();
  const session = await client.createSession();
  console.log('[dex/sdk] sessionId:', session.sessionId);
  console.log('[dex/sdk] deepLink :', session.deepLink);

  const side = await confirmAsWallet(session.sessionId, wallet);
  const { walletAddress, handshakeVerified, expiresAt } = await session.waitForConnection({ intervalMs: 300, timeoutMs: 15_000 });
  console.log('[dex/sdk] connected:', walletAddress, '| verified:', handshakeVerified, '| expiresAt:', expiresAt);
  assert(handshakeVerified, 'SDK did not verify the handshake proof');
  assert(walletAddress === wallet.address, `expected ${wallet.address}, got ${walletAddress}`);
  return { session, side };
}

async function happyPath(): Promise<void> {
  console.log('\n=== 1. Щасливий шлях ===');
  const { session, side } = await connect();

  const signed = session.sendTransaction(TX, { pollIntervalMs: 300 });
  await respondAsWallet(side, async (request) => {
    assert(JSON.stringify(request) === JSON.stringify({ v: 1, method: 'sendTransaction', params: TX }), 'request format');
    return { status: 'signed', result: { signedTxHex: SIGNED_TX } };
  });
  const signedTxHex = await signed;
  console.log('[dex/sdk] signedTxHex:', signedTxHex);
  assert(signedTxHex === SIGNED_TX, `unexpected signature value: ${signedTxHex}`);

  console.log('\n=== 2. Відмова гаманця з кодом ===');
  for (const [walletCode, sdkCode] of [
    ['user_rejected', 'signing_rejected'],
    ['signing_failed', 'wallet_signing_failed'],
  ] as const) {
    const pending = session.sendTransaction(TX, { pollIntervalMs: 300 }).catch((e: unknown) => e);
    await respondAsWallet(side, async () => ({ status: 'rejected', result: { error: { code: walletCode, message: `sim ${walletCode}` } } }));
    const err = await pending;
    assert(err instanceof MinterConnectError, `expected MinterConnectError, got ${String(err)}`);
    console.log('[dex/sdk]', walletCode, '->', err.code, '|', err.walletErrorMessage);
    assert(err.code === sdkCode, `expected ${sdkCode}, got ${err.code}`);
  }

  console.log('\n=== 3. Відновлення з serialize() ===');
  const state = session.serialize();
  session.close();
  const restored = await client.restoreSession(state);
  assert(restored.isConnected && restored.handshakeVerified, 'restored session is not connected/verified');
  const again = restored.sendTransaction(TX, { pollIntervalMs: 300 });
  await respondAsWallet(side, async () => ({ status: 'signed', result: { signedTxHex: SIGNED_TX } }));
  assert((await again) === SIGNED_TX, 'restored session did not sign');

  const forged = await client.restoreSession({ ...state, dexToken: 'A'.repeat(43) }).catch((e: unknown) => e);
  assert(forged instanceof MinterConnectError && forged.code === 'unauthorized', `expected unauthorized, got ${String(forged)}`);
  console.log('[dex/sdk] чужий dexToken ->', forged.code);
  restored.close();
}

async function revokedSession(): Promise<void> {
  console.log('\n=== 4. Відкликана сесія ===');
  const { session, side } = await connect();
  await revokeAsWallet(side);

  const err = await session.sendTransaction(TX, { pollIntervalMs: 300 }).catch((e: unknown) => e);
  assert(err instanceof MinterConnectError, `expected MinterConnectError, got ${String(err)}`);
  console.log('[dex/sdk] code:', err.code, '| httpStatus:', err.httpStatus, '| relayError:', err.relayError);
  assert(err.code === 'session_revoked', `expected session_revoked, got ${err.code}`);
  assert(err.requiresReconnect, 'session_revoked must be flagged as requiresReconnect');
  session.close();
}

/* --------------------------- сторона гаманця --------------------------- */

async function confirmAsWallet(sessionId: string, wallet: SimulatedWallet): Promise<WalletSide> {
  const pairing = await okJson<{ manifestUrl: string; dexPublicKeyHex: string }>(
    await fetch(`${RELAY_URL}/sessions/${sessionId}/pairing`),
    'GET /sessions/:id/pairing',
  );
  // Гаманець сам завантажує manifest і підписує host з manifest.url.
  const manifest = await okJson<{ url: string }>(await fetch(pairing.manifestUrl), 'GET manifest');
  const domain = new URL(manifest.url).host;
  const issuedAt = Date.now();

  const res = await fetch(`${RELAY_URL}/sessions/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: wallet.address,
      identityPublicKeyHex: wallet.identity.publicKeyHex,
      ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
      domain,
      issuedAt,
      signature: signMessage(
        wallet.identity.secretKey,
        canonicalHandshakeMessage(sessionId, wallet.ecdh.publicKeyHex, domain, issuedAt),
      ),
    }),
  });
  await okJson(res, 'POST /sessions/:id/confirm');
  console.log('[wallet/sim] confirmed as', wallet.address, 'for', domain);
  return { wallet, sessionId, aesKey: await deriveSharedAesKey(wallet.ecdh.secretKey, pairing.dexPublicKeyHex) };
}

type WalletDecision = { status: 'signed' | 'rejected'; result: unknown };

async function respondAsWallet(side: WalletSide, decide: (request: unknown) => Promise<WalletDecision>): Promise<void> {
  const pending = await waitForPending(side);
  const request = await decryptPayload(side.aesKey, pending.encryptedPayload);
  console.log('[wallet/sim] request:', JSON.stringify(request));

  const { status, result } = await decide(request);
  const encryptedResult = await encryptPayload(side.aesKey, result);
  const issuedAt = Date.now();
  const payloadHash = bytesToHex(sha256(new TextEncoder().encode(`${encryptedResult.iv}:${encryptedResult.ciphertext}`)));

  const res = await fetch(`${RELAY_URL}/requests/${pending.reqId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status,
      encryptedResult,
      identityPublicKeyHex: side.wallet.identity.publicKeyHex,
      issuedAt,
      signature: signMessage(
        side.wallet.identity.secretKey,
        `minter-connect:respond:${pending.reqId}:${status}:${payloadHash}:${issuedAt}`,
      ),
    }),
  });
  await okJson(res, 'PUT /requests/:reqId');
}

async function waitForPending(side: WalletSide): Promise<{ reqId: string; encryptedPayload: EncryptedPayload }> {
  const address = side.wallet.address;
  for (let i = 0; i < 50; i++) {
    const issuedAt = Date.now();
    const { requests } = await okJson<{ requests: Array<{ reqId: string; sessionId: string; encryptedPayload: EncryptedPayload }> }>(
      await fetch(`${RELAY_URL}/wallets/${address}/pending-requests`, {
        headers: {
          'x-wallet-pubkey': side.wallet.identity.publicKeyHex,
          'x-wallet-issued-at': String(issuedAt),
          'x-wallet-signature': signMessage(
            side.wallet.identity.secretKey,
            `minter-connect:pending-requests:${address.toLowerCase()}:${issuedAt}`,
          ),
        },
      }),
      'GET /wallets/:address/pending-requests',
    );
    const mine = requests.find((r) => r.sessionId === side.sessionId);
    if (mine) return mine;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('wallet sees no pending signing requests');
}

async function revokeAsWallet(side: WalletSide): Promise<void> {
  const issuedAt = Date.now();
  const res = await fetch(`${RELAY_URL}/sessions/${side.sessionId}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: side.wallet.address,
      identityPublicKeyHex: side.wallet.identity.publicKeyHex,
      signature: signMessage(side.wallet.identity.secretKey, canonicalRevokeMessage(side.sessionId, issuedAt)),
      issuedAt,
    }),
  });
  await okJson(res, 'POST /sessions/:id/revoke');
  console.log('[wallet/sim] session revoked');
}

/* ------------------------------ утиліти ------------------------------- */

/**
 * Кожен крок симуляції перевіряє res.ok: інакше 4xx від relay проходив би
 * непоміченим, і тест зависав би на поллінгу, показуючи не ту проблему.
 */
async function okJson<T = unknown>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await happyPath();
  await revokedSession();
  console.log('\nSDK E2E TEST PASSED');
} finally {
  manifestServer.close();
}
