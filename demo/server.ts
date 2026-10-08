/**
 * Мінімальне демо всього потоку з живим гаманцем:
 *   підключення → адреса → форма to/amount/coin → підпис → відправка в мережу.
 *
 * SDK тут працює на СЕРВЕРІ: dexToken і ephemeral-ключ сесії нікуди не
 * виходять, браузер бачить лише sessionId (він не секрет) і deepLink.
 *
 *   PUBLIC_URL=https://<ваш-тунель>  RELAY_URL=https://<relay гаманця>  \
 *   WALLET_APP_LINK=https://t.me/<Bot>/app  MINTER_NODE_URL=https://<node>/v2  npm run demo
 *
 * PUBLIC_URL — публічна https-адреса цього сервера (cloudflared/ngrok):
 * relay і гаманець самі завантажують з неї manifest. Для чисто локального
 * прогону з дев-relay (WEBHOOK_ALLOW_PRIVATE_NETWORK=true) підійде і
 * http://localhost:<PORT>, але справжній гаманець у Telegram до localhost не
 * дотягнеться.
 *
 * Не для продакшну: сесії в пам'яті, без авторизації юзерів сайту.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { MinterConnectClient, MinterConnectError, type MinterConnectSession } from '../src/index.js';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:3000';
const WALLET_APP_LINK = process.env.WALLET_APP_LINK ?? 'https://t.me/MinterWalletBot/app';
/** Minter Node API v2 (…/v2), наприклад той, яким користується гаманець. Потрібен лише для відправки. */
const MINTER_NODE_URL = process.env.MINTER_NODE_URL?.replace(/\/+$/, '');

const client = new MinterConnectClient({
  relayUrl: RELAY_URL,
  manifestUrl: `${PUBLIC_URL}/minter-connect-manifest.json`,
  walletAppLink: WALLET_APP_LINK,
});

const sessions = new Map<string, MinterConnectSession>();
const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const routes: Record<string, (req: IncomingMessage, body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
  /** Manifest: той самий host, https, ACAO * (гаманець вантажить його з браузера). */
  'GET /minter-connect-manifest.json': async () => ({
    url: PUBLIC_URL,
    name: 'Minter Connect demo',
    iconUrl: `${PUBLIC_URL}/icon.svg`,
  }),

  'POST /api/connect': async () => {
    const session = await client.createSession();
    sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId, deepLink: session.deepLink, expiresAt: session.expiresAt };
  },

  /** Довгий запит: відповідає, коли гаманець підтвердив (і доказ перевірено). */
  'GET /api/connection': async (_req, _body, url) => {
    const session = sessionFrom(url.searchParams.get('sessionId'));
    return session.waitForConnection();
  },

  'POST /api/sign': async (_req, body) => {
    const session = sessionFrom(body.sessionId);
    const signedTxHex = await session.sendTransaction({
      to: String(body.to ?? ''),
      amount: String(body.amount ?? ''),
      coin: String(body.coin ?? ''),
    });
    return { signedTxHex };
  },

  /** Відправку в мережу робить сайт — relay і гаманець транзакцію не транслюють. */
  'POST /api/broadcast': async (_req, body) => broadcast(String(body.signedTxHex ?? '')),
};

async function broadcast(signedTxHex: string): Promise<{ hash: string }> {
  if (!MINTER_NODE_URL) throw new Error('Set MINTER_NODE_URL (Minter Node API v2) to broadcast transactions');
  const tx = signedTxHex.startsWith('0x') ? signedTxHex : `0x${signedTxHex}`;
  const res = await fetch(`${MINTER_NODE_URL}/send_transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    hash?: string;
    transaction?: { hash?: string; code?: number; log?: string };
    error?: { message?: string };
  };
  if (!res.ok || data.error) throw new Error(`node rejected the transaction: ${data.error?.message ?? res.status}`);
  if (data.transaction?.code) throw new Error(`transaction failed with code ${data.transaction.code}: ${data.transaction.log}`);
  const hash = data.transaction?.hash ?? data.hash;
  if (!hash) throw new Error('node returned no transaction hash');
  return { hash };
}

function sessionFrom(id: unknown): MinterConnectSession {
  const session = typeof id === 'string' ? sessions.get(id) : undefined;
  if (!session) throw new MinterConnectError('session_not_found', 'Unknown demo session; connect again');
  return session;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', PUBLIC_URL);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/icon.svg') return send(res, 200, ICON, 'image/svg+xml');

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'not_found' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    return send(res, 200, await route(req, body, url));
  } catch (err) {
    const e = err instanceof MinterConnectError ? err : null;
    console.error('[demo]', err);
    return send(res, 400, {
      error: e?.code ?? 'error',
      message: err instanceof Error ? err.message : String(err),
      ...(e?.walletErrorMessage ? { walletErrorMessage: e.walletErrorMessage } : {}),
    });
  }
});

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, {
    'content-type': type,
    // Потрібно для manifest: гаманець у Telegram читає його з браузера.
    'access-control-allow-origin': '*',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2f6df6"/>' +
  '<path d="M16 44V20l16 14 16-14v24" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg>';

server.listen(PORT, () => {
  console.log(`[demo] http://localhost:${PORT}  (public: ${PUBLIC_URL})`);
  console.log(`[demo] relay ${RELAY_URL}, wallet ${WALLET_APP_LINK}, node ${MINTER_NODE_URL ?? '(not set — broadcast disabled)'}`);
});
