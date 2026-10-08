/**
 * Вміст запитів і результатів, версія 1 (docs/API.md бекенду → «Вміст
 * запитів і результатів»). Relay цих об'єктів не бачить і не валідує — це
 * контракт між сайтом і гаманцем, тому SDK перевіряє params ТИМИ САМИМИ
 * правилами, що й гаманець: помилка виклику стає `invalid_request` одразу, а
 * не `wallet_bad_request` через хвилину очікування і пуш юзеру в Telegram.
 */

import { MinterConnectError, type MinterConnectErrorCode, type SendTransactionParams } from './types.js';

export const REQUEST_FORMAT_VERSION = 1;

/** Рівно те, що шифрується в encryptedPayload. */
export interface SendTransactionRequest {
  v: typeof REQUEST_FORMAT_VERSION;
  method: 'sendTransaction';
  params: SendTransactionParams;
}

const TO_RE = /^Mx[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
const COIN_RE = /^[A-Z0-9-]{3,10}$/;
const PARAM_KEYS = ['to', 'amount', 'coin'] as const;

/**
 * Будує запит і відкидає все, що гаманець відхилив би з `bad_request`,
 * включно із зайвими полями: гаманець їх не ігнорує, а відмовляє.
 */
export function buildSendTransactionRequest(params: SendTransactionParams): SendTransactionRequest {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw invalid('params must be an object { to, amount, coin }');
  }

  const extra = Object.keys(params).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k));
  if (extra.length) {
    throw invalid(
      `Unsupported params field(s): ${extra.join(', ')}. The wallet accepts only { to, amount, coin } and picks ` +
        'nonce, fee and chainId itself',
    );
  }

  const { to, amount, coin } = params as Partial<Record<(typeof PARAM_KEYS)[number], unknown>>;
  if (typeof to !== 'string' || !TO_RE.test(to)) {
    throw invalid(`params.to must be a Minter address (Mx + 40 hex), got ${describe(to)}`);
  }
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
    throw invalid(
      `params.amount must be a decimal string in coins (not pip), e.g. '1.5', up to 18 decimals, ` +
        `without sign or exponent; got ${describe(amount)}`,
    );
  }
  // Формат уже гарантує лише цифри й одну крапку, тож "> 0" = є ненульова цифра.
  if (!/[1-9]/.test(amount)) throw invalid('params.amount must be greater than zero');
  if (typeof coin !== 'string' || !COIN_RE.test(coin)) {
    throw invalid(
      `params.coin must be a ticker of 3–10 characters A-Z, 0-9, '-' (case is not normalized), got ${describe(coin)}`,
    );
  }

  // Новий об'єкт, а не params: у шифротекст не має потрапити нічого, крім
  // цих трьох полів, навіть якщо об'єкт інтегратора — інстанс класу з геттерами.
  return { v: REQUEST_FORMAT_VERSION, method: 'sendTransaction', params: { to, amount, coin } };
}

/** `error.code` гаманця у `rejected` -> код SDK. */
const WALLET_ERROR_CODES: Record<string, MinterConnectErrorCode> = {
  user_rejected: 'signing_rejected',
  bad_request: 'wallet_bad_request',
  signing_failed: 'wallet_signing_failed',
};

/**
 * Помилка для `status: rejected`. `result` — розшифрований encryptedResult,
 * або `undefined`, якщо його немає чи він не розшифровується: за API.md це
 * трактується як `bad_request` (у гаманця немає ключа цієї сесії).
 */
export function walletRejectionError(reqId: string, result: unknown): MinterConnectError {
  const error = result && typeof result === 'object' ? (result as { error?: unknown }).error : undefined;
  const walletCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const walletMessage = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  const details = typeof walletMessage === 'string' ? { walletErrorMessage: walletMessage } : {};

  if (result === undefined) {
    return new MinterConnectError(
      'wallet_bad_request',
      `Request ${reqId} was rejected without an encrypted result: the wallet could not read it (no key for this ` +
        'session on that device), or the session was revoked. If it repeats, ask the user to reconnect.',
    );
  }

  const code = typeof walletCode === 'string' ? WALLET_ERROR_CODES[walletCode] : undefined;
  if (code === 'signing_rejected') {
    return new MinterConnectError('signing_rejected', 'User rejected the signing request in their wallet', details);
  }
  if (code === 'wallet_signing_failed') {
    return new MinterConnectError(
      'wallet_signing_failed',
      `Wallet could not build or sign the transaction for request ${reqId} (network, balance, unknown coin…)`,
      details,
    );
  }
  // bad_request і будь-який невідомий код: гаманець вважає запит некоректним.
  return new MinterConnectError(
    'wallet_bad_request',
    `Wallet rejected request ${reqId} as malformed` +
      (code === undefined ? ` (unknown wallet error code: ${describe(walletCode)})` : ''),
    details,
  );
}

function invalid(message: string): MinterConnectError {
  return new MinterConnectError('invalid_request', message);
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
