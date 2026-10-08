/**
 * Независимая проверка handshake на стороне DEX.
 *
 * Зачем: без неё SDK берёт walletAddress и walletPublicKeyHex (ECDH-ключ
 * канала) на слово relay. То есть E2E-шифрование не даёт ничего против самого
 * relay — а это главная причина строить такую схему: кто контролирует relay или
 * TLS-терминирующий прокси, подставляет свой ECDH-ключ, читает все "зашифрованные"
 * транзакции, и ни одна проверка адреса этого не замечает.
 *
 * Relay хранит доказательство (identity-ключ + подпись кошелька) и отдаёт его в
 * GET /sessions/:sessionId именно для этой проверки. Проверяем:
 *   1) подписанный домен — НАШ (из конфига, не из ответа relay);
 *   2) подпись не протухла и не "из будущего";
 *   3) identityPublicKeyHex разворачивается РОВНО в заявленный walletAddress;
 *   4) подпись валидна для канонического сообщения, в которое входят
 *      ecdhPublicKeyHex и домен — поэтому подменённый ключ канала делает подпись
 *      невалидной.
 *
 * Логика — копия verifyHandshake из minter-backend/src/shared/handshake.ts.
 * Расхождение ловит test/relay-compat.test.ts (фиксированные векторы из бэкенда).
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export interface HandshakeClaim {
  sessionId: string;
  walletAddress: string;
  identityPublicKeyHex: string;
  /** ECDH-ключ канала — тот же walletPublicKeyHex, который отдал relay. */
  ecdhPublicKeyHex: string;
  /** Домен, который кошелёк ПОДПИСАЛ (host из manifest.url). Из ответа relay — поэтому лишь заявка. */
  domain: string;
  /** Unix-время подписи в миллисекундах. */
  issuedAt: number;
  signature: string;
}

export interface HandshakeExpectations {
  /** СОБСТВЕННЫЙ домен сайта из конфига. Никогда не значение из ответа relay. */
  expectedDomain: string;
  /**
   * Насколько старой может быть подпись на момент проверки. `Infinity` —
   * свежесть не проверяется (восстановление сессии, которой может быть до 7 дней);
   * подпись "из будущего" сверх расхождения часов отклоняется всегда.
   */
  maxAgeMs: number;
  now?: number;
}

export type HandshakeFailure = 'domain_mismatch' | 'stale_proof' | 'address_mismatch' | 'invalid_signature';

/** Допустимое расхождение часов кошелька и сайта — то же PROOF_MAX_AGE_MS, что в relay. */
export const PROOF_MAX_CLOCK_SKEW_MS = 120_000;

const MINTER_ADDRESS_RE = /^Mx[0-9a-fA-F]{40}$/;

/**
 * Домен в подписи — `URL.host`: нижний регистр, порт только нестандартный.
 * Нормализация та же, что в relay (`normalizeDomain`), иначе `App.Example`
 * и `app.example` давали бы разные строки подписи.
 */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Каноническое сообщение relay (`canonicalMessage.handshake`). Hex — всегда в
 * нижнем регистре: схемы relay принимают любой регистр, поэтому без
 * нормализации подпись не совпала бы с сообщением, собранным из того, что relay
 * отдал.
 */
export function handshakeMessage(sessionId: string, ecdhPublicKeyHex: string, domain: string, issuedAt: number): string {
  return `minter-connect:handshake:${sessionId}:${ecdhPublicKeyHex.toLowerCase()}:${normalizeDomain(domain)}:${issuedAt}`;
}

/**
 * Порядок проверок — как в relay: домен, свежесть, адрес, подпись.
 * Домен в подписи — аналог `ton_proof`: подпись, которую кошелёк дал
 * фишинговому сайту, здесь не пройдёт, потому что expectedDomain другой.
 */
export function verifyHandshake(claim: HandshakeClaim, expect: HandshakeExpectations): HandshakeFailure | null {
  if (normalizeDomain(claim.domain) !== normalizeDomain(expect.expectedDomain)) return 'domain_mismatch';

  const now = expect.now ?? Date.now();
  if (!Number.isSafeInteger(claim.issuedAt)) return 'stale_proof';
  // Будущее — только в пределах расхождения часов, иначе подпись "с запасом"
  // жила бы сколько угодно.
  if (now - claim.issuedAt > expect.maxAgeMs || claim.issuedAt - now > PROOF_MAX_CLOCK_SKEW_MS) return 'stale_proof';

  if (!publicKeyMatchesAddress(claim.identityPublicKeyHex, claim.walletAddress)) return 'address_mismatch';

  let valid = false;
  try {
    valid = verifySignature(
      claim.identityPublicKeyHex,
      handshakeMessage(claim.sessionId, claim.ecdhPublicKeyHex, claim.domain, claim.issuedAt),
      claim.signature,
    );
  } catch {
    // Структурно некорректный ввод (не-hex, точка не на кривой) — для нас это
    // такой же отказ, как и неверная подпись.
    valid = false;
  }
  return valid ? null : 'invalid_signature';
}

/**
 * address = last20( keccak256( 64 байта координат БЕЗ префикса 0x04 ) ), с
 * префиксом "Mx" вместо "0x". Хеш РОВНО от 64 байт: если захешировать все 65
 * (с 0x04), получится другой адрес — и никакой ошибки при этом не будет.
 */
export function publicKeyToMinterAddress(publicKeyHex: string): string {
  const raw64 = toRawCoordinates(publicKeyHex);
  return `Mx${secp.etc.bytesToHex(keccak_256(raw64).slice(-20))}`;
}

function publicKeyMatchesAddress(publicKeyHex: string, address: string): boolean {
  try {
    if (!MINTER_ADDRESS_RE.test(address)) return false;
    return publicKeyToMinterAddress(publicKeyHex) === `Mx${address.slice(2).toLowerCase()}`;
  } catch {
    return false;
  }
}

function verifySignature(publicKeyHex: string, message: string, signatureHex: string): boolean {
  // @noble/secp256k1 v3 не тянет хеш сам; verify без этого бросает
  // "hashes.sha256 not set". Присваивание идемпотентно и без побочных эффектов
  // для окружения, поэтому делаем его лениво, а не при импорте модуля.
  secp.hashes.sha256 ??= sha256;
  const msgHash = sha256(new TextEncoder().encode(message));
  return secp.verify(secp.etc.hexToBytes(signatureHex), msgHash, secp.etc.hexToBytes(publicKeyHex));
}

/** Принимает ключ в compressed (33), uncompressed (65) или "сырых" координатах (64). */
function toRawCoordinates(publicKeyHex: string): Uint8Array {
  const hex = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('invalid_public_key_hex');

  const bytes = secp.etc.hexToBytes(hex.toLowerCase());
  // Point.fromBytes проверяет, что точка действительно лежит на кривой: без этого
  // 65 нулевых байт с префиксом 0x04 "успешно" превратились бы в адрес.
  const forPoint = bytes.length === 64 ? secp.etc.concatBytes(Uint8Array.of(0x04), bytes) : bytes;
  return secp.Point.fromBytes(forPoint).toBytes(false).subarray(1);
}
