# minter-connect-sdk

SDK для сайтів (DEX), щоб підключатися до Minter-гаманців через pairing-relay
без сид-фрази й приватного ключа на стороні сайту. Користувач підтверджує
підключення й підписує транзакції у своєму гаманці (Telegram Mini App), а ваш
застосунок ніколи не бачить ані ключа, ані сид-фрази.

> **2.0 — breaking change.** SDK приведено до relay з manifest і `dexToken`
> (контракт: `minter-backend/docs/API.md`). Що змінилось: `dexName` →
> `manifestUrl`, `walletBotUsername` → `walletAppLink`, `sign(txParams)` →
> `sendTransaction({ to, amount, coin })`, `SerializedSession` v1 → v2.
> Сесії 1.x не відновлюються, потрібне нове підключення.

## Вимоги

- **Node.js ≥ 20.19.0** (вимога `@noble/hashes@2`) або сучасний браузер із Web Crypto API.
  У браузері сторінка має бути в безпечному контексті (HTTPS або `localhost`),
  інакше `crypto.subtle` недоступний і SDK одразу кине `crypto_unavailable`.
- Relay протоколу minter-connect з manifest і `dexToken` (гілка `feat/wallet-dex-auth` бекенду або новіша).
- Manifest вашого сайту за https-адресою (див. [«Manifest»](#manifest)).

## Встановлення

```bash
npm install minter-connect-sdk
```

## Швидкий старт

```typescript
import { MinterConnectClient, MinterConnectError } from 'minter-connect-sdk';

const client = new MinterConnectClient({
  relayUrl: 'https://relay.example.com',
  manifestUrl: 'https://dex.example/minter-connect-manifest.json',
  walletAppLink: 'https://t.me/MinterWalletBot/app', // Direct Link Mini App з BotFather
});

// 1. Створюємо сесію і показуємо користувачу посилання (кнопка) або QR (десктоп)
const session = await client.createSession();
showConnect(session.deepLink); // https://t.me/MinterWalletBot/app?startapp=connect_<sessionId>

// 2. Чекаємо, поки користувач підтвердить підключення
const { walletAddress, expiresAt } = await session.waitForConnection();
// SDK уже перевірив доказ handshake: підписано НАШ домен, адреса виведена з
// ключа гаманця, а підпис покриває ключ шифрування каналу.

// 3. ОБОВ'ЯЗКОВО покажіть адресу користувачу: сесію підтверджує той, хто першим
//    відкрив посилання (див. «Хто підтверджує сесію»).
await askUserToConfirmAddress(walletAddress);

// 4. Просимо гаманець підписати переказ
try {
  const signedTxHex = await session.sendTransaction({ to: 'Mx…', amount: '1.5', coin: 'BIP' });
  await broadcast(signedTxHex); // у мережу відправляє сайт, див. «Відправка транзакції»
} catch (err) {
  if (err instanceof MinterConnectError) {
    if (err.requiresReconnect) {
      // сесії більше немає: показуємо кнопку «підключити гаманець» заново
    } else if (err.code === 'signing_rejected') {
      // користувач сказав «ні», це не помилка застосунку
    }
  }
  throw err;
} finally {
  session.close(); // зупиняє поллінг, якщо щось ще лишилось у польоті
}
```

## Як це працює

```
Сайт      POST /sessions {dexPublicKeyHex, manifestUrl}  → sessionId, dexToken
Сайт      показує <walletAppLink>?startapp=connect_<sessionId> (QR / кнопка)
Гаманець  сам завантажує manifestUrl, показує юзеру name + host(manifest.url)
Гаманець  підтверджує: підписує handshake з цим доменом
Сайт      GET /sessions/:id [Bearer dexToken] → перевіряє доказ зі СВОЇМ доменом
Сайт      POST /sessions/:id/requests [Bearer] (шифротекст { v:1, method, params })
Гаманець  показує переказ юзеру, підписує, повертає зашифрований результат
Сайт      GET /requests/:reqId [Bearer] → signedTxHex → сам відправляє в мережу
```

1. `createSession()` створює pairing-сесію і отримує `dexToken`, токен доступу
   сайту до цієї сесії. SDK шле його як `Authorization: Bearer` на всі маршрути
   сайту. У `deepLink` токен не потрапляє ніколи.
2. Користувач відкриває `deepLink`. Гаманець сам завантажує ваш manifest і
   показує назву та домен саме звідти, а не зі слів relay.
3. `waitForConnection()` поллить relay, поки сесія не стане `connected`,
   перевіряє доказ handshake і виводить ключ каналу.
4. `sendTransaction()` шифрує запит, ставить його в чергу relay, чекає підпису й
   повертає `signedTxHex`.

Уся криптографія (ECDH, AES-256-GCM, перевірка підписів secp256k1) працює
всередині SDK. Relay бачить лише шифротекст.

## Manifest

Розмістіть JSON на своєму домені й передайте його адресу як `manifestUrl`:

```json
{ "url": "https://dex.example", "name": "Dex", "iconUrl": "https://dex.example/icon.png" }
```

Вимоги relay (інакше `createSession()` кине `invalid_manifest`, причина в `err.relayError`):

| Вимога | relayError при порушенні |
|---|---|
| `manifestUrl`, `url`, `iconUrl` тільки `https`, без логіна/пароля, не на приватні адреси | `invalid_manifest_url` / `manifest_invalid` |
| `URL.host` у `url` **дорівнює** host у `manifestUrl` | `manifest_domain_mismatch` |
| `name` 1..64 символи після trim; розмір до 16 КБ; без редиректів | `manifest_invalid` / `manifest_unreachable` |
| Сервер віддає manifest relay | `manifest_unreachable` |

Гаманець завантажує manifest **з браузера** (Telegram WebView), тому сервер має
віддавати заголовок `Access-Control-Allow-Origin: *`. Без нього relay сесію
створить, а гаманець показати її не зможе.

Host із `manifest.url` (нижній регістр, порт лише нестандартний: `dex.example`,
`dex.example:8443`) і є доменом, який гаманець підписує в handshake. Для
локальної розробки з relay у дев-режимі (`WEBHOOK_ALLOW_PRIVATE_NETWORK=true`)
SDK приймає й `http://localhost:<port>`.

## Хто підтверджує сесію

Сесію підтверджує **той, хто першим** надішле валідне підтвердження. Посилання з
`sessionId` (QR, кнопка, скріншот) не секрет: будь-хто, хто його побачив, може
за 5 хвилин pairing підтвердити сесію **своїм** гаманцем. Relay цьому не запобігає
і не може, бо не знає, який гаманець «правильний».

SDK гарантує, що підключення справжнє: підписано вашим доменом, адреса належить
ключу, ключ каналу не підмінено. Але **чий** це гаманець, вирішує людина. Тому:

1. після `waitForConnection()` покажіть користувачу `walletAddress` і не вважайте
   її адресою користувача, доки той її не побачив;
2. якщо адреса прив'язана до облікового запису на сайті, перевіряйте, що
   підключилась та сама адреса, що й раніше, а не довіряйте першому підключенню;
3. «Скасувати» / «Спробувати ще раз» = нова сесія (`createSession()`) і
   `close()` старої. Окремого маршруту відмови немає, покинута сесія сама
   протухне.

## API

### `new MinterConnectClient(config)`

| Поле | Тип | Обов'язкове | Опис |
|---|---|---|---|
| `relayUrl` | `string` | так | URL relay-сервера |
| `manifestUrl` | `string` | так | https-адреса manifest сайту |
| `walletAppLink` | `string` | так | Direct Link Mini App гаманця (`https://t.me/<Bot>/app`), без query |
| `domain` | `string` | ні | Власний домен сайту для перевірки handshake. За замовчуванням host із `manifestUrl`; інше значення одразу дає `invalid_request`, бо такий підпис не пройшов би ніколи |
| `callbackUrl` | `string` | ні | Вебхук для всіх сесій цього клієнта (див. «Вебхуки») |
| `requestTimeoutMs` | `number` | ні | Таймаут ОДНОГО HTTP-запиту, за замовчуванням `10000` |
| `requireHandshakeProof` | `boolean` | ні | Вимагати доказ handshake; за замовчуванням `true` |

Конструктор перевіряє конфіг одразу й кидає `invalid_request` на не-https
`manifestUrl`, `walletAppLink` із query чи fragment і `domain`, що не збігається
з host `manifestUrl`.

`client.domain` — домен, з яким SDK звіряє підпис. Він береться **тільки з
конфігу**, ніколи не з відповіді relay (`dexDomain`).

### `client.createSession(options?): Promise<MinterConnectSession>`

| Опція | Опис |
|---|---|
| `callbackUrl` | Вебхук саме для цієї сесії; перекриває значення з конфігу |
| `requestId` | Значення `X-Request-Id`: наскрізний traceId у логах relay і в заголовку вебхука |

### `client.restoreSession(state): Promise<MinterConnectSession>`

Відновлює сесію зі стану, збереженого через `session.serialize()`, див.
[«Персистентність сесії»](#персистентність-сесії).

### `MinterConnectSession`

| Член | Тип | Опис |
|---|---|---|
| `sessionId` | `string` | Ідентифікатор сесії в relay (не секрет) |
| `deepLink` | `string` | `<walletAppLink>?startapp=connect_<sessionId>` для кнопки або QR |
| `walletAddress` | `string \| null` | Заповнюється після `waitForConnection()` |
| `expiresAt` | `string \| null` | ISO-8601. До підтвердження це дедлайн pairing'у (5 хв), після нього дедлайн сесії (7 днів) |
| `handshakeVerified` | `boolean` | Чи перевірено доказ handshake самостійно |
| `isConnected` | `boolean` | `true`, коли handshake пройдено і сесія готова підписувати |
| `isClosed` | `boolean` | `true` після `close()` |

#### `waitForConnection(options?): Promise<{ walletAddress, expiresAt, handshakeVerified }>`

| Опція | За замовч. | Опис |
|---|---|---|
| `intervalMs` | `2000` | Стартовий інтервал поллінгу (далі росте, з джитером ±20%) |
| `maxIntervalMs` | `10000` | Стеля інтервалу |
| `timeoutMs` | дедлайн пейрінгу з relay + 10 с | Бюджет очікування; після нього `connection_timeout` |

Виходить **одразу**, якщо сесію відкликано (`session_revoked`) або вона протухла
(`session_expired`). Доказ handshake тут приймається, лише якщо він не старший за
10 хвилин. На вже підключеній (наприклад, відновленій) сесії метод одразу
повертає поточний результат.

#### `sendTransaction(params, options?): Promise<string>`

Найпростіший шлях: створює запит і чекає результат. Повертає `signedTxHex`, а
відправку в мережу робите ви (див. [«Відправка транзакції»](#відправка-транзакції)).

| Поле `params` | Формат |
|---|---|
| `to` | `Mx` + 40 hex |
| `amount` | **рядок**, десяткове число в **монетах, не в pip**: `^(0\|[1-9][0-9]*)(\.[0-9]{1,18})?$`, строго більше нуля. Без експоненти, знака і пробілів |
| `coin` | тикер `^[A-Z0-9-]{3,10}$` (`'BIP'`, `'LP-123'`). Регістр не нормалізується: `'bip'` не пройде |

Інших полів немає й бути не може: nonce, комісію, монету комісії, chainId і
payload гаманець визначає сам, тож сайт не може їх підкласти. SDK перевіряє
`params` тими самими правилами, що й гаманець, включно із забороною зайвих
полів. Некоректний виклик одразу дає `invalid_request`, без запиту до relay і
без пуша користувачу.

`options` — це `requestId` плюс опції `waitForSignature()`.

#### `requestTransaction(params, options?): Promise<string>`

Те саме, але повертає `reqId` одразу. Потрібен, щоб надіслати кілька
транзакцій і чекати їх незалежно через `waitForSignature(reqId)`.

#### `waitForSignature(reqId, options?): Promise<string>`

| Опція | За замовч. | Опис |
|---|---|---|
| `pollIntervalMs` | `2000` | Стартовий інтервал поллінгу |
| `maxIntervalMs` | `5000` | Стеля інтервалу |
| `timeoutMs` | `expiresAt` запиту + 15 с | Бюджет очікування |

Дефолтний таймаут **виводиться з `expiresAt`**, який relay повернув на створення
запиту, плюс запас. Так SDK гарантовано доживає до фінального статусу й віддає
`signing_expired` («гаманець не встиг») замість беззмістовного `signing_timeout`.

Відмову гаманця SDK розшифровує і мапить за `error.code`:

| Гаманець | SDK | Що сталось |
|---|---|---|
| `user_rejected` | `signing_rejected` | Юзер відхилив запит |
| `bad_request` | `wallet_bad_request` | Гаманець вважає запит некоректним (версія, метод, params) |
| `signing_failed` | `wallet_signing_failed` | Запит коректний, але підписати не вдалося (мережа, баланс, монети не існує) |
| `rejected` без результату | `wallet_bad_request` | Гаманець не зміг навіть відповісти шифровано: немає ключа сесії (інший пристрій, очищене сховище) або сесію відкликано. Якщо повторюється, запропонуйте перепідключитись |

Текст від гаманця лежить у `err.walletErrorMessage`. Він для людини, не для
логіки: розгалужуйтесь за `code`.

#### `serialize(): SerializedSession`

Стан для збереження між запусками сайту. Див. [«Персистентність сесії»](#персистентність-сесії).

#### `close()` / `dispose()`

Зупиняє всі цикли поллінгу цієї сесії й перериває запити, що вже в польоті.
Ідемпотентний. Викликайте, коли користувач пішов зі сторінки або скасував
операцію, інакше `waitForConnection()` довбитиме relay до свого таймауту.

**Сесію на relay це не відкликає**: відкликати може лише власник гаманця.

## Відправка транзакції

Relay і гаманець транзакцію **не транслюють**: `signedTxHex` у мережу відправляє
сайт сам, через Minter Node API v2 (`send_transaction`) або Gate API. Приклад для
Node.js без залежностей:

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

З [`minter-js-sdk`](https://github.com/MinterTeam/minter-js-sdk) це те саме:

```typescript
import { Minter } from 'minter-js-sdk';
const minter = new Minter({ apiType: 'node', baseURL: process.env.MINTER_NODE_URL });
const { hash } = await minter.postSignedTx(signedTxHex);
```

## Обробка помилок

Усі помилки SDK — інстанси `MinterConnectError`. Розрізняйте їх за `code`,
а не за текстом повідомлення.

| `code` | HTTP | Коли | Що робити |
|---|---|---|---|
| `session_revoked` | 410 | Користувач відкликав доступ у гаманці | Нове підключення |
| `session_expired` | 410 | Сесія протухла (pairing 5 хв / сесія 7 днів) | Нове підключення |
| `session_not_found` | 404 | Relay не знає такої сесії | Нове підключення |
| `unauthorized` | 401/403 | `dexToken` відсутній або не від цієї сесії (`missing_dex_token` / `invalid_dex_token`) | Нове підключення; перевірте, що зберігаєте токен разом із сесією |
| `invalid_manifest` | 422 | Relay не прийняв manifest (`invalid_manifest_url`, `manifest_unreachable`, `manifest_invalid`, `manifest_domain_mismatch`) | Виправити manifest/конфіг, причина в `relayError` |
| `signing_rejected` | — | Користувач відхилив запит | Показати це користувачу |
| `wallet_bad_request` | — | Гаманець вважає запит некоректним або не може його прочитати | Перевірити версію SDK/гаманця; якщо повторюється, перепідключитись |
| `wallet_signing_failed` | — | Гаманець не зміг підписати (баланс, мережа, монета) | Показати `walletErrorMessage` |
| `signing_expired` | 410 | Запит протух (90 с), гаманець не відповів | Повторити запит |
| `request_not_found` | 404 | Relay не знає такого `reqId` | Повторити запит |
| `already_finalized` | 409 | Запит уже завершено | Забрати результат `waitForSignature()` |
| `session_not_connected` | 400 | `sendTransaction()` до `waitForConnection()` | Виправити виклик |
| `handshake_invalid` | — | Доказ handshake не зійшовся: чужий домен, протухлий підпис, підмінена адреса чи ключ каналу (деталь у `relayError`) | **Не ретраїти**, розбиратись |
| `handshake_unverifiable` | — | Relay не дав доказу | Оновити relay або явно вимкнути перевірку |
| `invalid_request` | 400 | Некоректні `params`, конфіг, збережений стан або тіло запиту | Виправити виклик, дивитись `message` |
| `rate_limited` | 429 | Ліміт relay: IP (`rate_limited`) або сесії (`too_many_pending_requests`, `session_rate_limited`) | Чекати `retryAfterMs` |
| `connection_timeout` | — | Користувач не підтвердив за `timeoutMs` | Запропонувати ще раз |
| `signing_timeout` | — | Гаманець не відповів за `timeoutMs` | Запропонувати ще раз |
| `session_closed` | — | Виклик після `close()` | Це ваш власний сигнал скасування |
| `crypto_unavailable` | — | Немає `crypto.subtle` (не-HTTPS сторінка / застарілий Node) | Перевірити середовище |
| `relay_error` | 5xx | Relay зламався або відповів неочікувано | Повторити пізніше |
| `network_error` | — | Relay недосяжний або не відповів за `requestTimeoutMs` | Повторити |

Додаткові поля для програмних рішень:

```typescript
interface MinterConnectError {
  code: MinterConnectErrorCode;
  httpStatus?: number;          // статус відповіді relay
  relayError?: string;          // поле error з тіла relay (або причина провалу handshake)
  retryAfterMs?: number;        // для rate_limited: Retry-After або дефолт 5 с, якщо relay його не дав
  walletErrorMessage?: string;  // текст гаманця для signing_rejected / wallet_*
  isRetryable: boolean;         // network_error | relay_error | rate_limited
  requiresReconnect: boolean;   // session_revoked | session_expired | session_not_found | unauthorized
}
```

`handshake_invalid` свідомо **не** позначений `requiresReconnect`: автоматично
створювати нову сесію у відповідь на провалену перевірку означає повторити
спробу проти того самого relay, який щойно не зійшовся.

### Найчастіший реальний сценарій: `session_revoked`

Користувач відкликає доступ у гаманці. Це штатна дія, а не збій. Сесія після
цього мертва назавжди: relay віддає 410 на будь-який запит у неї, а всі
pending-запити одразу переводяться в `rejected`. Ретраї не допоможуть
**ніколи**.

```typescript
async function sendWithReconnect(getSession: () => Promise<MinterConnectSession>, params: SendTransactionParams) {
  let session = await getSession();
  try {
    return await session.sendTransaction(params);
  } catch (err) {
    if (err instanceof MinterConnectError && err.requiresReconnect) {
      session.close();
      dropStoredSession();               // видаліть збережений стан
      const fresh = await client.createSession();
      showConnectButton(fresh.deepLink); // користувач має підтвердити наново
      const { walletAddress } = await fresh.waitForConnection();
      await askUserToConfirmAddress(walletAddress);
      return fresh.sendTransaction(params);
    }
    throw err;
  }
}
```

Те саме стосується `waitForConnection()`: він виходить із `session_revoked`
одразу, тому кнопку «підключитись знову» можна показати негайно.

### Ліміти relay

На IP: 120 запитів/хв загалом, 10/хв на створення сесії, 30/хв на створення
запиту на підпис. На сесію: не більше `SESSION_MAX_PENDING_REQUESTS` запитів
одночасно (`too_many_pending_requests`) і `SESSION_MAX_REQUESTS_PER_WINDOW` за
вікно (`session_rate_limited`). Для лімітів сесії relay не шле `Retry-After`,
тож SDK ставить `retryAfterMs` = 5 с.

У циклах поллінгу SDK обробляє 429 сам: чекає `retryAfterMs` і продовжує, якщо
бюджет `timeoutMs` це дозволяє. Для одноразових `createSession()` /
`requestTransaction()` 429 фатальний, з `retryAfterMs` у помилці.

Інтервали поллінгу мають ±20% джитера й плавно ростуть, щоб сотня паралельних
сесій одного сайту не била в relay синхронно.

## Перевірка handshake

Підтверджуючи підключення, гаманець підписує identity-ключем рядок

```
minter-connect:handshake:<sessionId>:<ecdhPublicKeyHex lowercase>:<domain lowercase>:<issuedAt ms>
```

де `domain` — host із manifest, який гаманець показав користувачу. Relay
зберігає доказ і віддає його в `GET /sessions/:sessionId`. SDK перевіряє його
**сам**, тією самою логікою, що й relay (`verifyHandshake` у
`minter-backend/src/shared/handshake.ts`), до того як вивести ключ каналу:

| Перевірка | Провал (`err.relayError`) |
|---|---|
| Підписаний домен дорівнює **вашому** `client.domain` | `domain_mismatch` |
| `issuedAt` не старший за 10 хв і не більше ніж на 120 с у майбутньому | `stale_proof` |
| `walletAddress` виводиться рівно з `identityPublicKeyHex` | `address_mismatch` |
| Підпис валідний для рядка з `walletPublicKeyHex` (ключ каналу), доменом і часом | `invalid_signature` |

Домен у підписі працює як `ton_proof`: доказ, який гаманець видав фішинговому
сайту, на справжньому не пройде. Тому очікуваний домен береться з вашого
конфігу, а не з `dexDomain` у відповіді relay. Інакше relay, що переслав
чужий доказ, сам назвав би «правильний» домен.

Без перевірки ключа каналу E2E-шифрування нічого не дає проти самого relay: хто
контролює relay або TLS-термінуючий проксі, підставляє свій ECDH-ключ і читає
всі «зашифровані» запити.

Будь-який провал дає `handshake_invalid`. Ретраїти його не можна, бо наступна
спроба піде в той самий relay.

При **відновленні** сесії (`restoreSession()`) свіжість не перевіряється:
handshake міг бути до 7 днів тому. Домен, адреса і підпис перевіряються завжди.

## Вебхуки

Якщо передати `callbackUrl`, relay після фіналізації кожного запиту зробить
`POST` на цей URL. Вебхук **доповнює поллінг, а не замінює його**: доставка
може не відбутись (черга лежить, ваш сервер віддав 4xx), тому
`waitForSignature()` лишається джерелом істини. Результат (шифротекст) забирайте
через SDK, а не з вебхука.

Вимоги relay до URL: `https`, стандартний порт, максимум 2048 символів, не в
приватну мережу. Інакше relay відповість 400 `invalid_callback_url` (SDK кине
`invalid_request` із причиною в `message`).

```http
POST <callbackUrl>
Content-Type: application/json
X-Request-Id: <traceId>
X-Relay-Timestamp: <unix seconds>
X-Relay-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>

{ "reqId": "...", "sessionId": "...", "status": "signed" | "rejected" | "expired" }
```

6 спроб з експоненційним бекофом (2 с, 4 с, 8 с, 16 с, 32 с). Відповідь 4xx
(крім 408 і 429) — остаточна відмова без ретраїв.

### Перевірка підпису обов'язкова

Без перевірки `X-Relay-Signature` ваш ендпоінт приймає підроблений колбек від
будь-кого, хто дізнався URL: «цю транзакцію підписано», і сайт відпускає товар.
Секрет той самий, що у relay в `WEBHOOK_SIGNING_SECRET`.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody — саме СИРЕ тіло запиту (Buffer/string), не результат JSON.parse:
// HMAC рахується над байтами, і будь-яка пересеріалізація його зламає.
export function verifyRelayWebhook(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const timestamp = headers['x-relay-timestamp'];
  const signature = headers['x-relay-signature'];
  if (!timestamp || !signature?.startsWith('sha256=')) return false;

  // Вікно свіжості проти replay: старий, колись перехоплений колбек не має прийматись.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');

  // Порівняння сталого часу: звичайне === витікає позицію першої розбіжності.
  return expected.length === received.length && timingSafeEqual(expected, received);
}
```

У Express сире тіло треба зберегти явно:

```typescript
app.post('/minter-webhook', express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); } }), (req, res) => {
  if (!verifyRelayWebhook((req as any).rawBody, req.headers as Record<string, string>, process.env.WEBHOOK_SIGNING_SECRET!)) {
    return res.sendStatus(401); // 4xx — relay більше не ретраїтиме цей колбек
  }
  // ... обробка req.body.status
  res.sendStatus(200);
});
```

## Персистентність сесії

Relay тримає підтверджену сесію 7 днів, але ephemeral-ключ ECDH і `dexToken`
живуть лише в пам'яті інстанса `MinterConnectSession`. Без збереження стану
перезавантаження вимагає нового пейрінгу.

```typescript
// Після успішного конекту
await store.put('minter-session', encrypt(JSON.stringify(session.serialize())));

// Після перезапуску
const raw = await store.get('minter-session');
if (raw) {
  try {
    const session = await client.restoreSession(JSON.parse(decrypt(raw)));
    if (session.isConnected) {
      // готово: можна одразу sendTransaction(), пейрінг не потрібен
    } else {
      // гаманець ще не підтвердив: показуємо session.deepLink і чекаємо
      await session.waitForConnection();
    }
  } catch (err) {
    if (err instanceof MinterConnectError && (err.requiresReconnect || err.code === 'invalid_request')) {
      await store.delete('minter-session'); // сесії більше немає або стан застарів
    } else throw err;
  }
}
```

`SerializedSession` — це `{ v: 2, sessionId, ephemeralSecretKeyHex, dexToken }`
і більше нічого. Ані адреса гаманця, ані `handshakeVerified` не зберігаються
навмисно: `restoreSession()` бере їх із `GET /sessions/:sessionId` і **перевіряє
доказ handshake заново** (домен, адресу, підпис), так само як при першому
підключенні.

> ⚠️ **`ephemeralSecretKeyHex` і `dexToken` — секрети. Зберігайте їх лише на
> сервері або зашифрованими.** З ephemeral-ключем можна розшифрувати трафік
> сесії. З `dexToken` можна від імені вашого сайту слати користувачу запити на
> підпис: підписує все одно лише він, але це готовий канал для фішингу. У
> браузері не кладіть цей стан у `localStorage` у відкритому вигляді.

Стан v1 (SDK 1.x, без `dexToken`) не відновлюється: relay закрив ті сесії при
міграції. `restoreSession()` кине `invalid_request` з поясненням, що потрібне
нове підключення.

Помилки `restoreSession()`: `session_revoked` / `session_expired` /
`session_not_found` / `unauthorized` (сесії немає або токен не підходить:
чистьте сховище і піднімайте новий пейрінг), `handshake_invalid` (доказ не
зійшовся, ретраєм не лікується), `invalid_request` (битий, застарілий або чужий
формат стану).

## Строки життя

| Що | Скільки | Наслідок |
|---|---|---|
| Pairing (від `createSession()` до підтвердження) | 5 хв | `session_expired` |
| Підтверджена сесія | 7 днів | `session_expired` на будь-який `sendTransaction()` |
| Окремий запит на підпис | 90 с | `signing_expired` |

Це дефолти relay, конкретний оператор може їх змінити. Не хардкодьте ці числа:
беріть `session.expiresAt` і покладайтесь на коди помилок.

## Безпека

- Жодна операція SDK не передає й не запитує приватний ключ або сид-фразу.
- Кожна сесія має власний ephemeral-ключ ECDH і власний `dexToken`:
  компрометація однієї сесії не зачіпає інші.
- `session.serialize()` віддає обидва секрети назовні, тож зберігайте
  результат лише на сервері або зашифрованим.
- Relay бачить лише шифротекст; розшифрувати може лише гаманець цієї сесії.
- Гаманець бере від сайту лише `to`, `amount`, `coin` і показує переказ
  користувачу перед підписом. SDK не може обійти це підтвердження.
- Підключену адресу завжди показуйте користувачу (див. «Хто підтверджує сесію»).
- Вхідні вебхуки перевіряйте за HMAC (див. вище). Без цього довіряти їм не можна.

## Демо

[`demo/`](demo) — мінімальна сторінка на весь потік з живим гаманцем:
підключення → адреса → форма `to/amount/coin` → підпис → відправка в мережу. SDK
там працює на сервері, тож `dexToken` і ключі в браузер не потрапляють.

```bash
PUBLIC_URL=https://<публічна https-адреса цього сервера> \
RELAY_URL=https://<relay, яким користується гаманець> \
WALLET_APP_LINK=https://t.me/<Bot>/app \
MINTER_NODE_URL=https://<node>/v2 \
npm run demo   # слухає PORT=8787
```

Relay і гаманець самі завантажують manifest з `PUBLIC_URL`, тому з телефоном
потрібна публічна https-адреса, наприклад тунель:
`cloudflared tunnel --url http://localhost:8787`. `MINTER_NODE_URL` потрібен
лише для кнопки «Відправити».

## Розробка

```bash
npm run typecheck      # tsc --noEmit по src, test і demo
npm test               # vitest: крипта, мапінг помилок, поллінг, handshake, сумісність із relay
npm run build          # tsc -p tsconfig.build.json -> dist/
npm run test:e2e       # ручний e2e проти живого relay
npm run fixtures:relay # перегенерувати test/fixtures/relay-vectors.json кодом бекенду
```

**Сумісність із бекендом.** `test/relay-compat.test.ts` перевіряє формат трьома
шарами: незалежною реалізацією на `node:crypto`; фіксованими векторами з
бекенду (`test/fixtures/relay-vectors.json`: ключі, рядки підпису, підписи,
вердикти `verifyHandshake`, шифротексти), які працюють і в CI; справжніми
примітивами relay, якщо поруч є чекаут `../minterWallet/minter-backend` (або
`MINTER_BACKEND_DIR`). Вектори перегенеровуйте лише разом зі зміною контракту на
бекенді.

Ручний e2e (relay у дев-режимі, `WEBHOOK_ALLOW_PRIVATE_NETWORK=true`: manifest
скрипт роздає сам із `http://localhost:5179`):

```bash
cd ../minterWallet/minter-backend && docker compose up -d && npm run migrate:up && npm run dev
# в іншому терміналі:
RELAY_URL=http://localhost:3000 npm run test:e2e
```
