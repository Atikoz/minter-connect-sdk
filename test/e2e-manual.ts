/**
 * РУЧНИЙ e2e-тест проти живого relay. У npm-пакет не потрапляє (rootDir=src).
 *
 *   cd ../minterWallet/minter-backend
 *   docker compose up -d && npm run migrate:up && npm run dev
 *   cd -  &&  npm run test:e2e
 *
 * Змінні: RELAY_URL (за замовчуванням http://localhost:3000),
 *         CALLBACK_URL (не обов'язково; relay прийме приватну мережу лише
 *         з WEBHOOK_ALLOW_PRIVATE_NETWORK=true).
 *
 * Сценаріїв два: щасливий шлях і відкликана сесія. Другий існує тому, що це
 * найчастіший реальний збій у проді, і саме на ньому SDK раніше віддавав
 * network_error замість session_revoked.
 */

import { MinterConnectClient, MinterConnectError, type MinterConnectSession } from '../src/index.js';
import { deriveSharedAesKey, encryptPayload, decryptPayload } from '../src/crypto.js';
import {
  canonicalHandshakeMessage,
  canonicalRevokeMessage,
  createSimulatedWallet,
  signMessage,
  type SimulatedWallet,
} from './helpers/wallet.js';

const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:3000';
const CALLBACK_URL = process.env.CALLBACK_URL;
const SIGNED_TX = 'f8a0deadbeefcafe';

const client = new MinterConnectClient({
  relayUrl: RELAY_URL,
  dexName: 'Test DEX via SDK',
  walletBotUsername: 'minter_wallet_bot',
  ...(CALLBACK_URL ? { callbackUrl: CALLBACK_URL } : {}),
});

async function happyPath(): Promise<void> {
  console.log('\n=== 1. Щасливий шлях ===');
  const wallet = createSimulatedWallet();
  const session: MinterConnectSession = await client.createSession();
  console.log('[dex/sdk] sessionId:', session.sessionId);
  console.log('[dex/sdk] deepLink :', session.deepLink);
  console.log('[dex/sdk] pairing expiresAt:', session.expiresAt);

  await confirmAsWallet(session.sessionId, wallet);

  const { walletAddress, expiresAt, handshakeVerified } = await session.waitForConnection({
    intervalMs: 300,
    timeoutMs: 15_000,
  });
  console.log('[dex/sdk] connected:', walletAddress, '| expiresAt:', expiresAt, '| handshakeVerified:', handshakeVerified);
  assert(handshakeVerified, 'SDK did not verify the handshake proof');
  assert(walletAddress === wallet.address, `expected ${wallet.address}, got ${walletAddress}`);
  assert(expiresAt !== null, 'relay did not return session expiresAt');

  const txParams = {
    chainId: 2,
    type: '0x01',
    data: { to: `Mx${'11'.repeat(20)}`, coin: 0, value: '10' },
  };
  const signedTxHexPromise = session.sign(txParams, { pollIntervalMs: 300 });

  await signAsWallet(session.sessionId, wallet, txParams);

  const signedTxHex = await signedTxHexPromise;
  console.log('[dex/sdk] signedTxHex:', signedTxHex);
  assert(signedTxHex === SIGNED_TX, `unexpected signature value: ${signedTxHex}`);

  session.close();
  assert(session.isClosed, 'close() did not mark the session closed');
}

async function revokedSession(): Promise<void> {
  console.log('\n=== 2. Відкликана сесія ===');
  const wallet = createSimulatedWallet();
  const session = await client.createSession();
  await confirmAsWallet(session.sessionId, wallet);
  await session.waitForConnection({ intervalMs: 300, timeoutMs: 15_000 });

  await revokeAsWallet(session.sessionId, wallet);

  const err = await session.sign({ type: '0x01', data: {} }, { pollIntervalMs: 300 }).catch((e: unknown) => e);
  assert(err instanceof MinterConnectError, `expected MinterConnectError, got ${String(err)}`);
  console.log('[dex/sdk] code:', err.code, '| httpStatus:', err.httpStatus, '| relayError:', err.relayError);
  assert(err.code === 'session_revoked', `expected session_revoked, got ${err.code}`);
  assert(err.requiresReconnect, 'session_revoked must be flagged as requiresReconnect');

  // І waitForConnection на мертвій сесії теж має виходити одразу, а не через таймаут.
  const startedAt = Date.now();
  const waitErr = await session.waitForConnection({ intervalMs: 300, timeoutMs: 30_000 }).catch((e: unknown) => e);
  assert(waitErr instanceof MinterConnectError, 'expected MinterConnectError from waitForConnection');
  assert(waitErr.code === 'session_revoked', `expected session_revoked, got ${waitErr.code}`);
  assert(Date.now() - startedAt < 5_000, 'waitForConnection polled until timeout instead of exiting on revoked');
  console.log('[dex/sdk] waitForConnection вийшов за', Date.now() - startedAt, 'мс');
}

/* --------------------------- сторона гаманця --------------------------- */

async function confirmAsWallet(sessionId: string, wallet: SimulatedWallet): Promise<void> {
  const res = await fetch(`${RELAY_URL}/sessions/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Адреса ВИВОДИТЬСЯ з identity-ключа: relay перевіряє відповідність і
      // віддає 401 invalid_proof на будь-яку вигадану на кшталт 'Mx_test'.
      walletAddress: wallet.address,
      identityPublicKeyHex: wallet.identity.publicKeyHex,
      ecdhPublicKeyHex: wallet.ecdh.publicKeyHex,
      // Підпис покриває і ECDH-ключ каналу — інакше relay міг би підмінити
      // його непомітно. Саме цей доказ SDK потім перевіряє сам.
      signature: signMessage(
        wallet.identity.secretKey,
        canonicalHandshakeMessage(sessionId, wallet.ecdh.publicKeyHex),
      ),
    }),
  });
  await okJson(res, 'POST /sessions/:id/confirm');
  console.log('[wallet/sim] confirmed as', wallet.address);
}

async function signAsWallet(sessionId: string, wallet: SimulatedWallet, expectedTx: unknown): Promise<void> {
  // Пауза, щоб SDK встиг реально почати поллінг waitForSignature().
  await new Promise((r) => setTimeout(r, 500));

  const dexPublicKeyHex = (
    await okJson<{ dexPublicKeyHex: string }>(await fetch(`${RELAY_URL}/sessions/${sessionId}`), 'GET /sessions/:id')
  ).dexPublicKeyHex;
  const aesKey = await deriveSharedAesKey(wallet.ecdh.secretKey, dexPublicKeyHex);

  const { requests } = await okJson<{ requests: Array<{ reqId: string; encryptedPayload: { iv: string; ciphertext: string } }> }>(
    await fetch(`${RELAY_URL}/wallets/${wallet.address}/pending-requests`),
    'GET /wallets/:address/pending-requests',
  );
  const pending = requests[0];
  assert(pending !== undefined, 'wallet sees no pending signing requests');

  const decrypted = await decryptPayload(aesKey, pending.encryptedPayload);
  console.log('[wallet/sim] decrypted tx:', JSON.stringify(decrypted));
  assert(JSON.stringify(decrypted) === JSON.stringify(expectedTx), 'decrypted tx differs from what the DEX sent');

  const res = await fetch(`${RELAY_URL}/requests/${pending.reqId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'signed', encryptedResult: await encryptPayload(aesKey, { signedTxHex: SIGNED_TX }) }),
  });
  await okJson(res, 'PUT /requests/:reqId');
}

async function revokeAsWallet(sessionId: string, wallet: SimulatedWallet): Promise<void> {
  const issuedAt = Date.now();
  const res = await fetch(`${RELAY_URL}/sessions/${sessionId}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: wallet.address,
      identityPublicKeyHex: wallet.identity.publicKeyHex,
      signature: signMessage(wallet.identity.secretKey, canonicalRevokeMessage(sessionId, issuedAt)),
      issuedAt,
    }),
  });
  await okJson(res, 'POST /sessions/:id/revoke');
  console.log('[wallet/sim] session revoked');
}

/* ------------------------------ утиліти ------------------------------- */

/**
 * Кожен крок симуляції перевіряє res.ok. Раніше цього не було, і 400 від
 * relay (наприклад на 'Mx_sdk_test_wallet') проходив непоміченим — тест
 * просто зависав на поллінгу до таймауту, показуючи не ту проблему.
 */
async function okJson<T = unknown>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await happyPath();
await revokedSession();
console.log('\nSDK E2E TEST PASSED');
