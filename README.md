# minter-connect-sdk

SDK для сайтов (DEX), чтобы подключаться к Minter-кошелькам через pairing-relay
без сид-фразы и приватного ключа на стороне сайта. Пользователь подтверждает
подключение и подписывает транзакции в своём кошельке (Telegram Mini App), а
ваше приложение никогда не видит ни ключа, ни сид-фразы.

> **2.0 — breaking change.** SDK приведён к relay с manifest и `dexToken`
> (контракт: `minter-backend/docs/API.md`). Что изменилось: `dexName` →
> `manifestUrl`, `walletBotUsername` → `walletAppLink`, `sign(txParams)` →
> `sendTransaction({ to, amount, coin })`, `SerializedSession` v1 → v2.
> Сессии 1.x не восстанавливаются, нужно новое подключение.

## Требования

- **Node.js ≥ 20.19.0** (требование `@noble/hashes@2`) или современный браузер с Web Crypto API.
  В браузере страница должна быть в безопасном контексте (HTTPS или `localhost`),
  иначе `crypto.subtle` недоступен и SDK сразу бросит `crypto_unavailable`.
- Relay протокола minter-connect с manifest и `dexToken` (ветка `feat/wallet-dex-auth` бэкенда или новее).
- Manifest вашего сайта по https-адресу (см. [«Manifest»](#manifest)).

## Установка

Пакет ставится из GitHub. Указывайте **тег версии**, а не ветку: `#main`
при каждом `npm install` берёт последний коммит, и любой следующий пуш
незаметно поменяет SDK у вас на сайте.

```bash
npm install github:Atikoz/minter-connect-sdk#v2.0.0
```

Это работает по https и без SSH-ключа (репозиторий публичный), в том числе в
CI. Если у вас настроен SSH-доступ к GitHub, то же самое через SSH:

```bash
npm install git+ssh://git@github.com/Atikoz/minter-connect-sdk.git#v2.0.0
```

При установке npm сам собирает `dist/` (скрипт `prepare`), поэтому на
машине нужен Node.js ≥ 20.19, и установка занимает чуть дольше, чем из npm.
Обновление на новую версию — та же команда с новым тегом.

## Быстрый старт

```typescript
import { MinterConnectClient, MinterConnectError } from 'minter-connect-sdk';

const client = new MinterConnectClient({
  relayUrl: 'https://relay.example.com',
  manifestUrl: 'https://dex.example/minter-connect-manifest.json',
  walletAppLink: 'https://t.me/MinterWalletBot/app', // Direct Link Mini App из BotFather
});

// 1. Создаём сессию и показываем пользователю ссылку (кнопка) или QR (десктоп)
const session = await client.createSession();
showConnect(session.deepLink); // https://t.me/MinterWalletBot/app?startapp=connect_<sessionId>

// 2. Ждём, пока пользователь подтвердит подключение
const { walletAddress, expiresAt } = await session.waitForConnection();
// SDK уже проверил доказательство handshake: подписан НАШ домен, адрес выведен
// из ключа кошелька, а подпись покрывает ключ шифрования канала.

// 3. ОБЯЗАТЕЛЬНО покажите адрес пользователю: сессию подтверждает тот, кто первым
//    открыл ссылку (см. «Кто подтверждает сессию»).
await askUserToConfirmAddress(walletAddress);

// 4. Просим кошелёк подписать перевод
try {
  const signedTxHex = await session.sendTransaction({ to: 'Mx…', amount: '1.5', coin: 'BIP' });
  await broadcast(signedTxHex); // в сеть отправляет сайт, см. «Отправка транзакции»
} catch (err) {
  if (err instanceof MinterConnectError) {
    if (err.requiresReconnect) {
      // сессии больше нет: показываем кнопку «подключить кошелёк» заново
    } else if (err.code === 'signing_rejected') {
      // пользователь сказал «нет», это не ошибка приложения
    }
  }
  throw err;
} finally {
  session.close(); // останавливает поллинг, если что-то ещё осталось в полёте
}
```

## Как это работает

```
Сайт      POST /sessions {dexPublicKeyHex, manifestUrl}  → sessionId, dexToken
Сайт      показывает <walletAppLink>?startapp=connect_<sessionId> (QR / кнопка)
Кошелёк   сам загружает manifestUrl, показывает юзеру name + host(manifest.url)
Кошелёк   подтверждает: подписывает handshake с этим доменом
Сайт      GET /sessions/:id [Bearer dexToken] → проверяет доказательство со СВОИМ доменом
Сайт      POST /sessions/:id/requests [Bearer] (шифротекст { v:1, method, params })
Кошелёк   показывает перевод юзеру, подписывает, возвращает зашифрованный результат
Сайт      GET /requests/:reqId [Bearer] → signedTxHex → сам отправляет в сеть
```

1. `createSession()` создаёт pairing-сессию и получает `dexToken`, токен доступа
   сайта к этой сессии. SDK шлёт его как `Authorization: Bearer` на все маршруты
   сайта. В `deepLink` токен не попадает никогда.
2. Пользователь открывает `deepLink`. Кошелёк сам загружает ваш manifest и
   показывает название и домен именно оттуда, а не со слов relay.
3. `waitForConnection()` опрашивает relay, пока сессия не станет `connected`,
   проверяет доказательство handshake и выводит ключ канала.
4. `sendTransaction()` шифрует запрос, ставит его в очередь relay, ждёт подписи и
   возвращает `signedTxHex`.

Вся криптография (ECDH, AES-256-GCM, проверка подписей secp256k1) работает
внутри SDK. Relay видит только шифротекст.

## Manifest

Разместите JSON на своём домене и передайте его адрес как `manifestUrl`:

```json
{ "url": "https://dex.example", "name": "Dex", "iconUrl": "https://dex.example/icon.png" }
```

Требования relay (иначе `createSession()` бросит `invalid_manifest`, причина в `err.relayError`):

| Требование | relayError при нарушении |
|---|---|
| `manifestUrl`, `url`, `iconUrl` только `https`, без логина/пароля, не на приватные адреса | `invalid_manifest_url` / `manifest_invalid` |
| `URL.host` в `url` **равен** host в `manifestUrl` | `manifest_domain_mismatch` |
| `name` 1..64 символа после trim; размер до 16 КБ; без редиректов | `manifest_invalid` / `manifest_unreachable` |
| Сервер отдаёт manifest relay | `manifest_unreachable` |

Кошелёк загружает manifest **из браузера** (Telegram WebView), поэтому сервер
должен отдавать заголовок `Access-Control-Allow-Origin: *`. Без него relay
сессию создаст, а кошелёк показать её не сможет.

Host из `manifest.url` (нижний регистр, порт только нестандартный: `dex.example`,
`dex.example:8443`) и есть домен, который кошелёк подписывает в handshake. Для
локальной разработки с relay в dev-режиме (`WEBHOOK_ALLOW_PRIVATE_NETWORK=true`)
SDK принимает и `http://localhost:<port>`.

## Кто подтверждает сессию

Сессию подтверждает **тот, кто первым** отправит валидное подтверждение. Ссылка с
`sessionId` (QR, кнопка, скриншот) не секрет: любой, кто её увидел, может за
5 минут pairing подтвердить сессию **своим** кошельком. Relay этому не
препятствует и не может, потому что не знает, какой кошелёк «правильный».

SDK гарантирует, что подключение настоящее: подписано вашим доменом, адрес
принадлежит ключу, ключ канала не подменён. Но **чей** это кошелёк, решает
человек. Поэтому:

1. после `waitForConnection()` покажите пользователю `walletAddress` и не считайте
   его адресом пользователя, пока тот его не увидел;
2. если адрес привязан к учётной записи на сайте, проверяйте, что подключился
   тот же адрес, что и раньше, а не доверяйте первому подключению;
3. «Отменить» / «Попробовать ещё раз» = новая сессия (`createSession()`) и
   `close()` старой. Отдельного маршрута отказа нет, брошенная сессия сама
   протухнет.

## API

### `new MinterConnectClient(config)`

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `relayUrl` | `string` | да | URL relay-сервера |
| `manifestUrl` | `string` | да | https-адрес manifest сайта |
| `walletAppLink` | `string` | да | Direct Link Mini App кошелька (`https://t.me/<Bot>/app`), без query |
| `domain` | `string` | нет | Собственный домен сайта для проверки handshake. По умолчанию host из `manifestUrl`; другое значение сразу даёт `invalid_request`, потому что такая подпись не прошла бы никогда |
| `callbackUrl` | `string` | нет | Вебхук для всех сессий этого клиента (см. «Вебхуки») |
| `requestTimeoutMs` | `number` | нет | Таймаут ОДНОГО HTTP-запроса, по умолчанию `10000` |
| `requireHandshakeProof` | `boolean` | нет | Требовать доказательство handshake; по умолчанию `true` |

Конструктор проверяет конфиг сразу и бросает `invalid_request` на не-https
`manifestUrl`, `walletAppLink` с query или fragment и `domain`, который не
совпадает с host `manifestUrl`.

`client.domain` — домен, с которым SDK сверяет подпись. Он берётся **только из
конфига**, никогда не из ответа relay (`dexDomain`).

### `client.createSession(options?): Promise<MinterConnectSession>`

| Опция | Описание |
|---|---|
| `callbackUrl` | Вебхук именно для этой сессии; перекрывает значение из конфига |
| `requestId` | Значение `X-Request-Id`: сквозной traceId в логах relay и в заголовке вебхука |

### `client.restoreSession(state): Promise<MinterConnectSession>`

Восстанавливает сессию из состояния, сохранённого через `session.serialize()`, см.
[«Персистентность сессии»](#персистентность-сессии).

### `MinterConnectSession`

| Член | Тип | Описание |
|---|---|---|
| `sessionId` | `string` | Идентификатор сессии в relay (не секрет) |
| `deepLink` | `string` | `<walletAppLink>?startapp=connect_<sessionId>` для кнопки или QR |
| `walletAddress` | `string \| null` | Заполняется после `waitForConnection()` |
| `expiresAt` | `string \| null` | ISO-8601. До подтверждения это дедлайн pairing'а (5 мин), после него дедлайн сессии (7 дней) |
| `handshakeVerified` | `boolean` | Проверено ли доказательство handshake самостоятельно |
| `isConnected` | `boolean` | `true`, когда handshake пройден и сессия готова подписывать |
| `isClosed` | `boolean` | `true` после `close()` |

#### `waitForConnection(options?): Promise<{ walletAddress, expiresAt, handshakeVerified }>`

| Опция | По умолч. | Описание |
|---|---|---|
| `intervalMs` | `2000` | Начальный интервал поллинга (дальше растёт, с джиттером ±20%) |
| `maxIntervalMs` | `10000` | Потолок интервала |
| `timeoutMs` | дедлайн пейринга из relay + 10 с | Бюджет ожидания; после него `connection_timeout` |

Выходит **сразу**, если сессию отозвали (`session_revoked`) или она протухла
(`session_expired`). Доказательство handshake здесь принимается, только если оно
не старше 10 минут. На уже подключённой (например, восстановленной) сессии метод
сразу возвращает текущий результат.

#### `sendTransaction(params, options?): Promise<string>`

Самый простой путь: создаёт запрос и ждёт результат. Возвращает `signedTxHex`, а
отправку в сеть делаете вы (см. [«Отправка транзакции»](#отправка-транзакции)).

| Поле `params` | Формат |
|---|---|
| `to` | `Mx` + 40 hex |
| `amount` | **строка**, десятичное число в **монетах, не в pip**: `^(0\|[1-9][0-9]*)(\.[0-9]{1,18})?$`, строго больше нуля. Без экспоненты, знака и пробелов |
| `coin` | тикер `^[A-Z0-9-]{3,10}$` (`'BIP'`, `'LP-123'`). Регистр не нормализуется: `'bip'` не пройдёт |

Других полей нет и быть не может: nonce, комиссию, монету комиссии, chainId и
payload кошелёк определяет сам, так что сайт не может их подложить. SDK
проверяет `params` теми же правилами, что и кошелёк, включая запрет лишних
полей. Некорректный вызов сразу даёт `invalid_request`, без запроса к relay и
без пуша пользователю.

`options` — это `requestId` плюс опции `waitForSignature()`.

#### `requestTransaction(params, options?): Promise<string>`

То же самое, но возвращает `reqId` сразу. Нужен, чтобы отправить несколько
транзакций и ждать их независимо через `waitForSignature(reqId)`.

#### `waitForSignature(reqId, options?): Promise<string>`

| Опция | По умолч. | Описание |
|---|---|---|
| `pollIntervalMs` | `2000` | Начальный интервал поллинга |
| `maxIntervalMs` | `5000` | Потолок интервала |
| `timeoutMs` | `expiresAt` запроса + 15 с | Бюджет ожидания |

Таймаут по умолчанию **выводится из `expiresAt`**, который relay вернул при
создании запроса, плюс запас. Так SDK гарантированно доживает до финального
статуса и отдаёт `signing_expired` («кошелёк не успел») вместо бессмысленного
`signing_timeout`.

Отказ кошелька SDK расшифровывает и мапит по `error.code`:

| Кошелёк | SDK | Что произошло |
|---|---|---|
| `user_rejected` | `signing_rejected` | Юзер отклонил запрос |
| `bad_request` | `wallet_bad_request` | Кошелёк считает запрос некорректным (версия, метод, params) |
| `signing_failed` | `wallet_signing_failed` | Запрос корректный, но подписать не удалось (сеть, баланс, монеты не существует) |
| `rejected` без результата | `wallet_bad_request` | Кошелёк не смог даже ответить шифрованно: нет ключа сессии (другое устройство, очищенное хранилище) или сессию отозвали. Если повторяется, предложите переподключиться |

Текст от кошелька лежит в `err.walletErrorMessage`. Он для человека, не для
логики: ветвитесь по `code`.

#### `serialize(): SerializedSession`

Состояние для сохранения между запусками сайта. См. [«Персистентность сессии»](#персистентность-сессии).

#### `close()` / `dispose()`

Останавливает все циклы поллинга этой сессии и прерывает запросы, которые уже в
полёте. Идемпотентный. Вызывайте, когда пользователь ушёл со страницы или
отменил операцию, иначе `waitForConnection()` будет долбить relay до своего
таймаута.

**Сессию на relay это не отзывает**: отозвать может только владелец кошелька.

## Отправка транзакции

Relay и кошелёк транзакцию **не транслируют**: `signedTxHex` в сеть отправляет
сайт сам, через Minter Node API v2 (`send_transaction`) или Gate API. Пример для
Node.js без зависимостей:

```typescript
async function broadcast(signedTxHex: string): Promise<string> {
  const tx = signedTxHex.startsWith('0x') ? signedTxHex : `0x${signedTxHex}`;
  const res = await fetch(`${process.env.MINTER_NODE_URL}/send_transaction`, { // напр. https://<node>/v2
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message ?? `node responded ${res.status}`);
  if (data.transaction?.code) throw new Error(`tx failed: ${data.transaction.log}`);
  return data.transaction?.hash ?? data.hash;
}
```

С [`minter-js-sdk`](https://github.com/MinterTeam/minter-js-sdk) это то же самое:

```typescript
import { Minter } from 'minter-js-sdk';
const minter = new Minter({ apiType: 'node', baseURL: process.env.MINTER_NODE_URL });
const { hash } = await minter.postSignedTx(signedTxHex);
```

## Обработка ошибок

Все ошибки SDK — инстансы `MinterConnectError`. Различайте их по `code`,
а не по тексту сообщения.

| `code` | HTTP | Когда | Что делать |
|---|---|---|---|
| `session_revoked` | 410 | Пользователь отозвал доступ в кошельке | Новое подключение |
| `session_expired` | 410 | Сессия протухла (pairing 5 мин / сессия 7 дней) | Новое подключение |
| `session_not_found` | 404 | Relay не знает такой сессии | Новое подключение |
| `unauthorized` | 401/403 | `dexToken` отсутствует или не от этой сессии (`missing_dex_token` / `invalid_dex_token`) | Новое подключение; проверьте, что сохраняете токен вместе с сессией |
| `invalid_manifest` | 422 | Relay не принял manifest (`invalid_manifest_url`, `manifest_unreachable`, `manifest_invalid`, `manifest_domain_mismatch`) | Исправить manifest/конфиг, причина в `relayError` |
| `signing_rejected` | — | Пользователь отклонил запрос | Показать это пользователю |
| `wallet_bad_request` | — | Кошелёк считает запрос некорректным или не может его прочитать | Проверить версию SDK/кошелька; если повторяется, переподключиться |
| `wallet_signing_failed` | — | Кошелёк не смог подписать (баланс, сеть, монета) | Показать `walletErrorMessage` |
| `signing_expired` | 410 | Запрос протух (90 с), кошелёк не ответил | Повторить запрос |
| `request_not_found` | 404 | Relay не знает такого `reqId` | Повторить запрос |
| `already_finalized` | 409 | Запрос уже завершён | Забрать результат `waitForSignature()` |
| `session_not_connected` | 400 | `sendTransaction()` до `waitForConnection()` | Исправить вызов |
| `handshake_invalid` | — | Доказательство handshake не сошлось: чужой домен, протухшая подпись, подменённый адрес или ключ канала (деталь в `relayError`) | **Не ретраить**, разбираться |
| `handshake_unverifiable` | — | Relay не дал доказательства | Обновить relay или явно отключить проверку |
| `invalid_request` | 400 | Некорректные `params`, конфиг, сохранённое состояние или тело запроса | Исправить вызов, смотреть `message` |
| `rate_limited` | 429 | Лимит relay: IP (`rate_limited`) или сессии (`too_many_pending_requests`, `session_rate_limited`) | Ждать `retryAfterMs` |
| `connection_timeout` | — | Пользователь не подтвердил за `timeoutMs` | Предложить ещё раз |
| `signing_timeout` | — | Кошелёк не ответил за `timeoutMs` | Предложить ещё раз |
| `session_closed` | — | Вызов после `close()` | Это ваш собственный сигнал отмены |
| `crypto_unavailable` | — | Нет `crypto.subtle` (не-HTTPS страница / устаревший Node) | Проверить окружение |
| `relay_error` | 5xx | Relay сломался или ответил неожиданно | Повторить позже |
| `network_error` | — | Relay недоступен или не ответил за `requestTimeoutMs` | Повторить |

Дополнительные поля для программных решений:

```typescript
interface MinterConnectError {
  code: MinterConnectErrorCode;
  httpStatus?: number;          // статус ответа relay
  relayError?: string;          // поле error из тела relay (или причина провала handshake)
  retryAfterMs?: number;        // для rate_limited: Retry-After или дефолт 5 с, если relay его не дал
  walletErrorMessage?: string;  // текст кошелька для signing_rejected / wallet_*
  isRetryable: boolean;         // network_error | relay_error | rate_limited
  requiresReconnect: boolean;   // session_revoked | session_expired | session_not_found | unauthorized
}
```

`handshake_invalid` сознательно **не** помечен `requiresReconnect`: автоматически
создавать новую сессию в ответ на проваленную проверку означает повторить
попытку против того же relay, который только что не сошёлся.

### Самый частый реальный сценарий: `session_revoked`

Пользователь отзывает доступ в кошельке. Это штатное действие, а не сбой. Сессия
после этого мертва навсегда: relay отдаёт 410 на любой запрос в неё, а все
pending-запросы сразу переводятся в `rejected`. Ретраи не помогут **никогда**.

```typescript
async function sendWithReconnect(getSession: () => Promise<MinterConnectSession>, params: SendTransactionParams) {
  let session = await getSession();
  try {
    return await session.sendTransaction(params);
  } catch (err) {
    if (err instanceof MinterConnectError && err.requiresReconnect) {
      session.close();
      dropStoredSession();               // удалите сохранённое состояние
      const fresh = await client.createSession();
      showConnectButton(fresh.deepLink); // пользователь должен подтвердить заново
      const { walletAddress } = await fresh.waitForConnection();
      await askUserToConfirmAddress(walletAddress);
      return fresh.sendTransaction(params);
    }
    throw err;
  }
}
```

То же касается `waitForConnection()`: он выходит с `session_revoked` сразу,
поэтому кнопку «подключиться снова» можно показать немедленно.

### Лимиты relay

На IP: 120 запросов/мин всего, 10/мин на создание сессии, 30/мин на создание
запроса на подпись. На сессию: не больше `SESSION_MAX_PENDING_REQUESTS` запросов
одновременно (`too_many_pending_requests`) и `SESSION_MAX_REQUESTS_PER_WINDOW` за
окно (`session_rate_limited`). Для лимитов сессии relay не шлёт `Retry-After`,
поэтому SDK ставит `retryAfterMs` = 5 с.

В циклах поллинга SDK обрабатывает 429 сам: ждёт `retryAfterMs` и продолжает,
если бюджет `timeoutMs` это позволяет. Для одноразовых `createSession()` /
`requestTransaction()` 429 фатален, с `retryAfterMs` в ошибке.

Интервалы поллинга имеют ±20% джиттера и плавно растут, чтобы сотня параллельных
сессий одного сайта не била в relay синхронно.

## Проверка handshake

Подтверждая подключение, кошелёк подписывает identity-ключом строку

```
minter-connect:handshake:<sessionId>:<ecdhPublicKeyHex lowercase>:<domain lowercase>:<issuedAt ms>
```

где `domain` — host из manifest, который кошелёк показал пользователю. Relay
хранит доказательство и отдаёт его в `GET /sessions/:sessionId`. SDK проверяет
его **сам**, той же логикой, что и relay (`verifyHandshake` в
`minter-backend/src/shared/handshake.ts`), до того как вывести ключ канала:

| Проверка | Провал (`err.relayError`) |
|---|---|
| Подписанный домен равен **вашему** `client.domain` | `domain_mismatch` |
| `issuedAt` не старше 10 мин и не больше чем на 120 с в будущем | `stale_proof` |
| `walletAddress` выводится ровно из `identityPublicKeyHex` | `address_mismatch` |
| Подпись валидна для строки с `walletPublicKeyHex` (ключ канала), доменом и временем | `invalid_signature` |

Домен в подписи работает как `ton_proof`: доказательство, которое кошелёк выдал
фишинговому сайту, на настоящем не пройдёт. Поэтому ожидаемый домен берётся из
вашего конфига, а не из `dexDomain` в ответе relay. Иначе relay, переславший
чужое доказательство, сам назвал бы «правильный» домен.

Без проверки ключа канала E2E-шифрование ничего не даёт против самого relay: кто
контролирует relay или TLS-терминирующий прокси, подставляет свой ECDH-ключ и
читает все «зашифрованные» запросы.

Любой провал даёт `handshake_invalid`. Ретраить его нельзя, потому что
следующая попытка пойдёт в тот же relay.

При **восстановлении** сессии (`restoreSession()`) свежесть не проверяется:
handshake мог быть до 7 дней назад. Домен, адрес и подпись проверяются всегда.

## Вебхуки

Если передать `callbackUrl`, relay после финализации каждого запроса сделает
`POST` на этот URL. Вебхук **дополняет поллинг, а не заменяет его**: доставка
может не произойти (очередь лежит, ваш сервер отдал 4xx), поэтому
`waitForSignature()` остаётся источником истины. Результат (шифротекст)
забирайте через SDK, а не из вебхука.

Требования relay к URL: `https`, стандартный порт, максимум 2048 символов, не в
приватную сеть. Иначе relay ответит 400 `invalid_callback_url` (SDK бросит
`invalid_request` с причиной в `message`).

```http
POST <callbackUrl>
Content-Type: application/json
X-Request-Id: <traceId>
X-Relay-Timestamp: <unix seconds>
X-Relay-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>

{ "reqId": "...", "sessionId": "...", "status": "signed" | "rejected" | "expired" }
```

6 попыток с экспоненциальным бэкофом (2 с, 4 с, 8 с, 16 с, 32 с). Ответ 4xx
(кроме 408 и 429) — окончательный отказ без ретраев.

### Проверка подписи обязательна

Без проверки `X-Relay-Signature` ваш эндпоинт принимает поддельный колбэк от
любого, кто узнал URL: «эта транзакция подписана», и сайт отпускает товар.
Секрет тот же, что у relay в `WEBHOOK_SIGNING_SECRET`.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody — именно СЫРОЕ тело запроса (Buffer/string), не результат JSON.parse:
// HMAC считается над байтами, и любая пересериализация его сломает.
export function verifyRelayWebhook(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const timestamp = headers['x-relay-timestamp'];
  const signature = headers['x-relay-signature'];
  if (!timestamp || !signature?.startsWith('sha256=')) return false;

  // Окно свежести против replay: старый, когда-то перехваченный колбэк не должен приниматься.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');

  // Сравнение за постоянное время: обычное === выдаёт позицию первого расхождения.
  return expected.length === received.length && timingSafeEqual(expected, received);
}
```

В Express сырое тело нужно сохранить явно:

```typescript
app.post('/minter-webhook', express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); } }), (req, res) => {
  if (!verifyRelayWebhook((req as any).rawBody, req.headers as Record<string, string>, process.env.WEBHOOK_SIGNING_SECRET!)) {
    return res.sendStatus(401); // 4xx — relay больше не будет ретраить этот колбэк
  }
  // ... обработка req.body.status
  res.sendStatus(200);
});
```

## Персистентность сессии

Relay держит подтверждённую сессию 7 дней, но ephemeral-ключ ECDH и `dexToken`
живут только в памяти инстанса `MinterConnectSession`. Без сохранения состояния
перезагрузка требует нового пейринга.

```typescript
// После успешного подключения
await store.put('minter-session', encrypt(JSON.stringify(session.serialize())));

// После перезапуска
const raw = await store.get('minter-session');
if (raw) {
  try {
    const session = await client.restoreSession(JSON.parse(decrypt(raw)));
    if (session.isConnected) {
      // готово: можно сразу sendTransaction(), пейринг не нужен
    } else {
      // кошелёк ещё не подтвердил: показываем session.deepLink и ждём
      await session.waitForConnection();
    }
  } catch (err) {
    if (err instanceof MinterConnectError && (err.requiresReconnect || err.code === 'invalid_request')) {
      await store.delete('minter-session'); // сессии больше нет или состояние устарело
    } else throw err;
  }
}
```

`SerializedSession` — это `{ v: 2, sessionId, ephemeralSecretKeyHex, dexToken }`
и больше ничего. Ни адрес кошелька, ни `handshakeVerified` не сохраняются
намеренно: `restoreSession()` берёт их из `GET /sessions/:sessionId` и
**проверяет доказательство handshake заново** (домен, адрес, подпись), так же как
при первом подключении.

> ⚠️ **`ephemeralSecretKeyHex` и `dexToken` — секреты. Храните их только на
> сервере или в зашифрованном виде.** С ephemeral-ключом можно расшифровать
> трафик сессии. С `dexToken` можно от имени вашего сайта слать пользователю
> запросы на подпись: подписывает всё равно только он, но это готовый канал для
> фишинга. В браузере не кладите это состояние в `localStorage` в открытом виде.

Состояние v1 (SDK 1.x, без `dexToken`) не восстанавливается: relay закрыл те
сессии при миграции. `restoreSession()` бросит `invalid_request` с пояснением,
что нужно новое подключение.

Ошибки `restoreSession()`: `session_revoked` / `session_expired` /
`session_not_found` / `unauthorized` (сессии нет или токен не подходит:
чистите хранилище и поднимайте новый пейринг), `handshake_invalid`
(доказательство не сошлось, ретраем не лечится), `invalid_request` (битый,
устаревший или чужой формат состояния).

## Сроки жизни

| Что | Сколько | Последствие |
|---|---|---|
| Pairing (от `createSession()` до подтверждения) | 5 мин | `session_expired` |
| Подтверждённая сессия | 7 дней | `session_expired` на любой `sendTransaction()` |
| Отдельный запрос на подпись | 90 с | `signing_expired` |

Это дефолты relay, конкретный оператор может их изменить. Не хардкодьте эти
числа: берите `session.expiresAt` и полагайтесь на коды ошибок.

## Безопасность

- Ни одна операция SDK не передаёт и не запрашивает приватный ключ или сид-фразу.
- У каждой сессии собственный ephemeral-ключ ECDH и собственный `dexToken`:
  компрометация одной сессии не затрагивает другие.
- `session.serialize()` отдаёт оба секрета наружу, так что храните результат
  только на сервере или в зашифрованном виде.
- Relay видит только шифротекст; расшифровать может только кошелёк этой сессии.
- Кошелёк берёт от сайта только `to`, `amount`, `coin` и показывает перевод
  пользователю перед подписью. SDK не может обойти это подтверждение.
- Подключённый адрес всегда показывайте пользователю (см. «Кто подтверждает сессию»).
- Входящие вебхуки проверяйте по HMAC (см. выше). Без этого доверять им нельзя.

## Демо

[`demo/`](demo) — минимальная страница на весь поток с живым кошельком:
подключение → адрес → форма `to/amount/coin` → подпись → отправка в сеть. SDK
там работает на сервере, так что `dexToken` и ключи в браузер не попадают.

```bash
PUBLIC_URL=https://<публичный https-адрес этого сервера> \
RELAY_URL=https://<relay, которым пользуется кошелёк> \
WALLET_APP_LINK=https://t.me/<Bot>/app \
MINTER_NODE_URL=https://<node>/v2 \
npm run demo   # слушает PORT=8787
```

Relay и кошелёк сами загружают manifest с `PUBLIC_URL`, поэтому с телефоном
нужен публичный https-адрес, например туннель:
`cloudflared tunnel --url http://localhost:8787`. `MINTER_NODE_URL` нужен только
для кнопки «Отправить».

### Весь стек одной командой

`npm run dev:stack` поднимает всё для живого теста с кошельком в Telegram:
Postgres и Redis (`docker compose` бэкенда), миграции, публичные https-адреса,
relay, Mini App кошелька и демо. Соседние чекауты ищутся в
`../minterWallet/minter-backend` и `../minterWallet/minter-wallet-miniapp`.

```bash
WALLET_APP_LINK=https://t.me/<Bot>/<short> MINTER_NODE_URL=https://<node>/v2 npm run dev:stack
```

Что делает скрипт:

- **Публичные адреса.** По умолчанию это три quick-туннеля cloudflared. Если
  они не создаются (`api.trycloudflare.com` недоступен), передайте собственные
  https-адреса, ведущие на порты 3000 / 5173 / 8787:
  `RELAY_PUBLIC_URL`, `WALLET_PUBLIC_URL`, `DEMO_PUBLIC_URL`.
- **Конфиг relay.** `.env` бэкенда не меняется: нужные значения
  (`PORT`, `WALLET_MINI_APP_URL` = адрес кошелька, `SESSION_TTL_MS` = 7 дней)
  передаются переменными окружения.
- **Конфиг кошелька.** В `.env.local` кошелька записывается только строка
  `VITE_RELAY_URL`, остальной файл не трогается.
- **Что остаётся вам.** В конце скрипт печатает адрес кошелька. Его нужно
  вписать в BotFather (`/myapps` → Edit Web App URL). Адреса quick-туннелей
  новые при каждом запуске.
- **Опции.** `WITH_WORKER=1` запускает ещё и worker. `SKIP_DB=1` — если Postgres
  и Redis уже подняты вами. Логи пишутся в `.dev-stack/`.
- **Остановка.** Ctrl+C останавливает всё, что запустил скрипт. Контейнеры БД
  остаются, их останавливает `docker compose down` в бэкенде.

## Разработка

```bash
npm run typecheck      # tsc --noEmit по src, test и demo
npm test               # vitest: крипта, маппинг ошибок, поллинг, handshake, совместимость с relay
npm run build          # tsc -p tsconfig.build.json -> dist/
npm run test:e2e       # ручной e2e против живого relay
npm run fixtures:relay # перегенерировать test/fixtures/relay-vectors.json кодом бэкенда
```

**Совместимость с бэкендом.** `test/relay-compat.test.ts` проверяет формат тремя
слоями: независимой реализацией на `node:crypto`; фиксированными векторами из
бэкенда (`test/fixtures/relay-vectors.json`: ключи, строки подписи, подписи,
вердикты `verifyHandshake`, шифротексты), которые работают и в CI; настоящими
примитивами relay, если рядом есть чекаут `../minterWallet/minter-backend` (или
`MINTER_BACKEND_DIR`). Векторы перегенерируйте только вместе с изменением
контракта на бэкенде.

Ручной e2e (relay в dev-режиме, `WEBHOOK_ALLOW_PRIVATE_NETWORK=true`: manifest
скрипт раздаёт сам с `http://localhost:5179`):

```bash
cd ../minterWallet/minter-backend && docker compose up -d && npm run migrate:up && npm run dev
# в другом терминале:
RELAY_URL=http://localhost:3000 npm run test:e2e
```
