/**
 * Генерирует test/fixtures/relay-vectors.json НАСТОЯЩИМ кодом бэкенда.
 *
 *   npm run fixtures:relay   # нужен соседний чекаут ../minterWallet/minter-backend
 *
 * Зачем: test/relay-compat.test.ts в CI не видит бэкенда рядом, и без
 * фиксированных векторов расхождение формата там просто не ловилось бы. Векторы
 * — это снимок контракта: ключи, строки подписи, подписи, вердикты
 * verifyHandshake и шифротексты, сделанные примитивами relay. SDK обязан
 * воспроизвести их байт в байт.
 *
 * Перегенерировать только вместе с изменением контракта на бэкенде. Если после
 * перегенерации тесты SDK красные — SDK разошёлся с бэкендом, а не векторы.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import * as secp from '@noble/secp256k1';

const BACKEND = resolve(process.env.MINTER_BACKEND_DIR ?? resolve(process.cwd(), '../minterWallet/minter-backend'));
const shared = (name: string) => pathToFileURL(resolve(BACKEND, 'src/shared', name)).href;

const crypto = (await import(shared('crypto-utils.ts'))) as {
  deriveSharedAesKey(sk: Uint8Array, pkHex: string): Promise<CryptoKey>;
  encryptPayload(key: CryptoKey, data: unknown): Promise<{ iv: string; ciphertext: string }>;
  signMessage(sk: Uint8Array, message: string): string;
};
const address = (await import(shared('address.ts'))) as { publicKeyToMinterAddress(pk: string): string };
const handshake = (await import(shared('handshake.ts'))) as {
  PROOF_MAX_AGE_MS: number;
  canonicalMessage: { handshake(sessionId: string, ecdh: string, domain: string, issuedAt: number): string };
  verifyHandshake(claim: Record<string, unknown>, expect: Record<string, unknown>): string | null;
};

/** Детерминированные ключи: секрет = sha256(метка). Вектор должен быть воспроизводимым. */
function keyPair(label: string) {
  const secretKey = sha256(new TextEncoder().encode(`minter-connect-sdk fixture: ${label}`));
  return { secretKeyHex: secp.etc.bytesToHex(secretKey), publicKeyHex: secp.etc.bytesToHex(secp.getPublicKey(secretKey)) };
}
const sk = (hex: string) => secp.etc.hexToBytes(hex);

const identity = keyPair('wallet identity');
const walletEcdh = keyPair('wallet ecdh');
const dexEcdh = keyPair('dex ecdh');
const other = keyPair('other wallet identity');
const walletAddress = address.publicKeyToMinterAddress(identity.publicKeyHex);

const sessionId = '3f2b6c1e-8d4a-4b7e-9c2f-1a5e7d9b0c42';
const domain = 'dex.example';
const issuedAt = 1_759_800_000_000;

// Кошелёк отправляет ключ в любом регистре; строка подписи — всегда нижний.
const message = handshake.canonicalMessage.handshake(sessionId, walletEcdh.publicKeyHex.toUpperCase(), 'Dex.Example', issuedAt);
const signature = crypto.signMessage(sk(identity.secretKeyHex), message);

const claim = {
  sessionId,
  walletAddress,
  identityPublicKeyHex: identity.publicKeyHex,
  ecdhPublicKeyHex: walletEcdh.publicKeyHex,
  domain,
  issuedAt,
  signature,
};
const maxAgeMs = 10 * 60_000;

/** Каждый кейс: что изменено в claim/expect и что на это ответил бэкенд. */
const cases: Array<{ name: string; claim: Record<string, unknown>; expect: Record<string, unknown> }> = [
  { name: 'valid', claim: {}, expect: {} },
  { name: 'valid: domain case and whitespace', claim: { domain: ' DEX.Example ' }, expect: { expectedDomain: 'Dex.EXAMPLE' } },
  { name: 'valid: uppercase hex', claim: { ecdhPublicKeyHex: walletEcdh.publicKeyHex.toUpperCase(), identityPublicKeyHex: identity.publicKeyHex.toUpperCase() }, expect: {} },
  { name: 'valid: future within clock skew', claim: {}, expect: { now: issuedAt - 60_000 } },
  { name: 'valid: no freshness (restore)', claim: {}, expect: { now: issuedAt + 6 * 24 * 3600_000, maxAgeMs: Number.MAX_SAFE_INTEGER } },
  { name: 'foreign expected domain', claim: {}, expect: { expectedDomain: 'phishing.example' } },
  { name: 'relay swapped signed domain', claim: { domain: 'phishing.example' }, expect: { expectedDomain: 'phishing.example' } },
  { name: 'port is part of the domain', claim: {}, expect: { expectedDomain: 'dex.example:8443' } },
  { name: 'too old', claim: {}, expect: { now: issuedAt + maxAgeMs + 1 } },
  { name: 'too far in the future', claim: {}, expect: { now: issuedAt - handshake.PROOF_MAX_AGE_MS - 1 } },
  { name: 'issuedAt changed', claim: { issuedAt: issuedAt + 1 }, expect: {} },
  { name: 'address of another key', claim: { walletAddress: address.publicKeyToMinterAddress(other.publicKeyHex) }, expect: {} },
  { name: 'ecdh key swapped', claim: { ecdhPublicKeyHex: dexEcdh.publicKeyHex }, expect: {} },
  { name: 'session id changed', claim: { sessionId: '00000000-0000-4000-8000-000000000000' }, expect: {} },
  { name: 'signature not hex', claim: { signature: 'zz'.repeat(64) }, expect: {} },
];

const verifyCases = cases.map(({ name, claim: patch, expect: expectPatch }) => {
  const c = { ...claim, ...patch };
  const e = { expectedDomain: domain, maxAgeMs, now: issuedAt + 30_000, ...expectPatch };
  return { name, claim: c, expect: e, result: handshake.verifyHandshake(c, e) };
});

// E2E: шифротексты делает бэкенд на стороне кошелька, SDK должен их прочитать.
const walletKey = await crypto.deriveSharedAesKey(sk(walletEcdh.secretKeyHex), dexEcdh.publicKeyHex);
const request = { v: 1, method: 'sendTransaction', params: { to: walletAddress, amount: '1.5', coin: 'BIP' } };
const results = {
  request: { plaintext: request, encrypted: await crypto.encryptPayload(walletKey, request) },
  signed: { plaintext: { signedTxHex: 'f8a00102030405' }, encrypted: await crypto.encryptPayload(walletKey, { signedTxHex: 'f8a00102030405' }) },
  rejected: Object.fromEntries(
    await Promise.all(
      (['user_rejected', 'bad_request', 'signing_failed'] as const).map(async (code) => {
        const plaintext = { error: { code, message: `fixture ${code}` } };
        return [code, { plaintext, encrypted: await crypto.encryptPayload(walletKey, plaintext) }] as const;
      }),
    ),
  ),
};

const vectors = {
  generatedFrom: 'minter-backend src/shared (crypto-utils.ts, address.ts, handshake.ts)',
  keys: { identity, walletEcdh, dexEcdh, other },
  walletAddress,
  handshake: {
    input: { sessionId, ecdhPublicKeyHex: walletEcdh.publicKeyHex.toUpperCase(), domain: 'Dex.Example', issuedAt },
    message,
    signature,
    proofMaxAgeMs: handshake.PROOF_MAX_AGE_MS,
  },
  verifyHandshake: verifyCases,
  e2e: results,
};

const out = resolve(process.cwd(), 'test/fixtures/relay-vectors.json');
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}: ${verifyCases.length} verifyHandshake cases`);
for (const v of verifyCases) console.log(`  ${v.name} -> ${v.result ?? 'null'}`);
