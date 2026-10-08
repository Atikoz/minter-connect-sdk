# minter-connect-sdk

Клієнтський SDK для підключення DEX-застосунків до Minter-гаманців через
pairing-relay — без сид-фрази й приватного ключа на стороні DEX. Користувач
підтверджує підключення й підписує транзакції у своєму гаманці (Telegram Mini
App); ваш застосунок ніколи не бачить ані ключа, ані сид-фрази.

## Вимоги

- **Node.js ≥ 20.19.0** (вимога `@noble/hashes@2`) або сучасний браузер із Web Crypto API.
  У браузері сторінка має бути в безпечному контексті — HTTPS або `localhost`,
  інакше `crypto.subtle` недоступний і SDK одразу кине `crypto_unavailable`.
- Працюючий relay-сервер протоколу minter-connect.

## Встановлення

```bash
npm install minter-connect-sdk
```

## Швидкий старт

```typescript
import { MinterConnectClient, MinterConnectError } from 'minter-connect-sdk';

const client = new MinterConnectClient({
  relayUrl: 'https://relay.example.com',
  dexName: 'My DEX',
  walletBotUsername: 'minter_wallet_bot', // username бота гаманця в Telegram, без @
});

// 1. Створюємо сесію і показуємо користувачу посилання/QR
const session = await client.createSession();
console.log('Відкрий у гаманці:', session.deepLink);

// 2. Чекаємо, поки користувач підтвердить підключення
const { walletAddress, expiresAt } = await session.waitForConnection();
console.log('Підключено:', walletAddress, '— сесія дійсна до', expiresAt);
// SDK уже перевірив доказ handshake: адреса виведена з ключа гаманця,
// а підпис покриває ключ шифрування каналу.

// 3. Надсилаємо транзакцію на підпис
try {
  const signedTxHex = await session.sign({
    chainId: 1,
    type: '0x01', // TX_TYPE.SEND з minter-js-sdk
    data: { to: 'Mx...', coin: 0, value: '10' }, // coin — числовий coinId, не символ
  });
  // далі — broadcast через minter-js-sdk на вашому бекенді
} catch (err) {
  if (err instanceof MinterConnectError) {
    if (err.requiresReconnect) {
      // сесії більше немає — показуємо кнопку "підключити гаманець" заново
    } else if (err.code === 'signing_rejected') {
      // користувач сказав "ні" — це не помилка застосунку
    }
  }
  throw err;
} finally {
  session.close(); // зупиняє поллінг, якщо ще щось лишилось у польоті
}
```

## Як це працює

1. `createSession()` створює pairing-сесію на relay і повертає `deepLink` виду
   `https://t.me/{bot}/app?startapp=connect_{sessionId}` — покажіть його як кнопку або QR.
2. Користувач відкриває посилання, гаманець показує попап "X хоче підключитись".
3. `waitForConnection()` поллить relay, поки статус сесії не стане `connected`,
   і повертає адресу гаманця та строк життя сесії.
4. `sign(txParams)` шифрує unsigned-транзакцію, ставить її в чергу relay, чекає
   підпису й повертає готовий `signedTxHex`.

Уся криптографія (ECDH-обмін ключами, AES-256-GCM) відбувається всередині SDK.
Relay бачить лише шифротекст.

## API

### `new MinterConnectClient(config)`

| Поле | Тип | Обов'язкове | Опис |
|---|---|---|---|
| `relayUrl` | `string` | так | URL relay-сервера |
| `dexName` | `string` | так | Ім'я в попапі підтвердження, 1..64 символи |
| `walletBotUsername` | `string` | так | username Telegram-бота гаманця, без `@` |
| `callbackUrl` | `string` | ні | Вебхук для всіх сесій цього клієнта (див. нижче) |
| `requestTimeoutMs` | `number` | ні | Таймаут ОДНОГО HTTP-запиту, за замовчуванням `10000` |
| `requireHandshakeProof` | `boolean` | ні | Перевіряти доказ handshake; за замовчуванням `true` (див. «Перевірка handshake») |

### `client.createSession(options?): Promise<MinterConnectSession>`

| Опція | Опис |
|---|---|
| `callbackUrl` | Вебхук саме для цієї сесії; перекриває значення з конфігу |
| `requestId` | Значення `X-Request-Id` — наскрізний traceId у логах relay і в заголовку вебхука |

### `client.restoreSession(state): Promise<MinterConnectSession>`

Відновлює сесію зі стану, збереженого через `session.serialize()` — див.
[«Персистентність сесії»](#персистентність-сесії).

### `MinterConnectSession`

| Член | Тип | Опис |
|---|---|---|
| `sessionId` | `string` | Ідентифікатор сесії в relay |
| `deepLink` | `string` | Готове посилання для кнопки або QR |
| `walletAddress` | `string \| null` | Заповнюється після `waitForConnection()` |
| `expiresAt` | `string \| null` | ISO-8601. До підтвердження — дедлайн pairing'у (5 хв), після — дедлайн сесії (7 днів) |
| `handshakeVerified` | `boolean` | Чи перевірено доказ handshake самостійно |
| `isConnected` | `boolean` | `true`, коли handshake пройдено і сесія готова підписувати |
| `isClosed` | `boolean` | `true` після `close()` |

#### `waitForConnection(options?): Promise<{ walletAddress, expiresAt, handshakeVerified }>`

| Опція | За замовч. | Опис |
|---|---|---|
| `intervalMs` | `2000` | Стартовий інтервал поллінгу (далі росте, з джитером ±20%) |
| `maxIntervalMs` | `10000` | Стеля інтервалу |
| `timeoutMs` | дедлайн пейрінгу з relay + 10 с | Бюджет очікування; після нього — `connection_timeout` |

Виходить **одразу**, не чекаючи таймауту, якщо сесію відкликано (`session_revoked`)
або вона протухла (`session_expired`).

За замовчуванням бюджет береться з `expiresAt`, який relay повернув на
`POST /sessions` (дефолт — 5 хв), а не з константи в SDK: інакше SDK здавався б
раніше, ніж протухає посилання, і користувач отримував би `connection_timeout`
на цілком робочому QR. Явний `timeoutMs` це перекриває.

#### `sign(txParams, options?): Promise<string>`

Найпростіший шлях: створює запит і чекає результат. Повертає `signedTxHex`
(broadcast робите самі).

#### `requestSignature(txParams, options?): Promise<string>`

Повертає `reqId` одразу. Потрібен, якщо треба надіслати кілька транзакцій і
чекати їх незалежно.

#### `waitForSignature(reqId, options?): Promise<string>`

| Опція | За замовч. | Опис |
|---|---|---|
| `pollIntervalMs` | `2000` | Стартовий інтервал поллінгу |
| `maxIntervalMs` | `5000` | Стеля інтервалу |
| `timeoutMs` | `expiresAt` запиту + 15 с | Бюджет очікування |

Дефолтний таймаут **виводиться з `expiresAt`**, який relay повернув на створення
запиту, плюс запас. Так SDK гарантовано доживає до фінального статусу й віддає
`signing_expired` ("гаманець не встиг") замість беззмістовного `signing_timeout`.

#### `serialize(): SerializedSession`

Стан для збереження між запусками DEX. Див. [«Персистентність сесії»](#персистентність-сесії).

#### `close()` / `dispose()`

Зупиняє всі цикли поллінгу цієї сесії й перериває запити, що вже в польоті.
Ідемпотентний. Викликайте, коли користувач пішов зі сторінки або скасував
операцію — інакше `waitForConnection()` довбитиме relay до свого таймауту.

**Сесію на relay це не відкликає** — відкликати може лише власник гаманця.

## Обробка помилок

Усі помилки SDK — інстанси `MinterConnectError`. Розрізняйте їх за `code`,
а не за текстом повідомлення.

| `code` | HTTP | Коли | Що робити |
|---|---|---|---|
| `session_revoked` | 410 | Користувач відкликав доступ у гаманці | Нове підключення |
| `session_expired` | 410 | Сесія протухла (pairing 5 хв / сесія 7 днів) | Нове підключення |
| `session_not_found` | 404 | Relay не знає такої сесії | Нове підключення |
| `signing_rejected` | — | Користувач натиснув "Відхилити" | Показати це користувачу |
| `signing_expired` | 410 | Запит протух (90 с), гаманець не відповів | Повторити запит |
| `request_not_found` | 404 | Relay не знає такого `reqId` | Повторити запит |
| `already_finalized` | 409 | Запит уже завершено | Забрати результат `waitForSignature()` |
| `session_not_connected` | 400 | `sign()` до `waitForConnection()` | Виправити виклик |
| `handshake_invalid` | — | Доказ handshake не зійшовся — relay міг підмінити адресу або ключ каналу | **Не ретраїти**, розбиратись |
| `handshake_unverifiable` | — | Relay не дав доказу (старіша версія) | Оновити relay або явно вимкнути перевірку |
| `invalid_request` | 400 | Relay відхилив тіло запиту (валідація, `invalid_callback_url`) | Виправити виклик, дивитись `message` |
| `rate_limited` | 429 | Впертись у ліміт relay | Чекати `retryAfterMs` |
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
  httpStatus?: number;      // статус відповіді relay
  relayError?: string;      // поле error з тіла relay
  retryAfterMs?: number;    // для rate_limited — із заголовка Retry-After
  isRetryable: boolean;     // network_error | relay_error | rate_limited
  requiresReconnect: boolean; // session_revoked | session_expired | session_not_found
}
```

`handshake_invalid` свідомо **не** позначений `requiresReconnect`: автоматично
створювати нову сесію у відповідь на провалену перевірку означає повторити
спробу проти того самого relay, який щойно не зійшовся.

### Найчастіший реальний сценарій: `session_revoked`

Користувач відкликає доступ у гаманці — це штатна дія, а не збій. Сесія після
цього мертва назавжди: relay віддає 410 на будь-який запит у неї, а всі
pending-запити на підпис одразу переводяться в `rejected`. Ретраї не допоможуть
**ніколи**.

```typescript
async function signWithReconnect(getSession: () => Promise<MinterConnectSession>, txParams: TxParams) {
  let session = await getSession();
  try {
    return await session.sign(txParams);
  } catch (err) {
    if (err instanceof MinterConnectError && err.requiresReconnect) {
      session.close();
      dropStoredSession();            // видаліть sessionId зі свого сховища
      const fresh = await client.createSession();
      showConnectButton(fresh.deepLink); // користувач має підтвердити наново
      await fresh.waitForConnection();
      return fresh.sign(txParams);
    }
    throw err;
  }
}
```

Те саме стосується `waitForConnection()`: він виходить із `session_revoked`
одразу, тому кнопку "підключитись знову" можна показати негайно.

### Ліміти relay

Ліміт рахується **на IP**: 120 запитів/хв загалом, 10/хв на створення сесії,
30/хв на створення запиту на підпис. У циклах поллінгу SDK обробляє 429 сам:
чекає стільки, скільки просить `Retry-After`, і продовжує, якщо бюджет
`timeoutMs` це дозволяє. Для одноразового `createSession()` 429 — фатальний,
з `retryAfterMs` у помилці.

Інтервали поллінгу мають ±20% джитера й плавно ростуть — щоб сотня паралельних
сесій одного DEX не била в relay синхронно.

## Перевірка handshake

Коли гаманець підтверджує підключення, він підписує канонічне повідомлення

```
minter-connect:handshake:<sessionId>:<ecdhPublicKeyHex у нижньому регістрі>
```

своїм identity-ключем. Relay зберігає доказ (`identityPublicKeyHex` +
`handshakeSignature`) і віддає його в `GET /sessions/:sessionId`.
`waitForConnection()` перевіряє його **сам**, перед тим як вивести ключ каналу:

1. `walletAddress` має виводитись рівно з `identityPublicKeyHex`
   (`Mx` + останні 20 байт keccak256 від 64 байт координат **без** префікса `0x04`);
2. підпис має бути валідним для повідомлення, у яке входить `walletPublicKeyHex` —
   той самий ECDH-ключ, на якому SDK збирається шифрувати транзакції.

Без цієї перевірки E2E-шифрування не дає нічого проти самого relay: хто
контролює relay або TLS-термінуючий проксі, підставляє свій ECDH-ключ, читає
всі «зашифровані» транзакції й перешифровує їх далі гаманцю — а адреса при
цьому лишається справжньою, тож зовні все виглядає нормально.

Провал перевірки — це `handshake_invalid`. Ретраїти його не можна: наступна
спроба піде в той самий relay.

`requireHandshakeProof: false` вимикає перевірку і потрібен лише для relay
старішого за цей формат (він поверне `identityPublicKeyHex: null`). У цьому разі
`waitForConnection()` підключиться, але поверне `handshakeVerified: false` —
перевіряйте це поле, якщо вимикаєте перевірку.

## Вебхуки

Якщо передати `callbackUrl`, relay після фіналізації кожного запиту зробить
`POST` на цей URL. Вебхук **доповнює поллінг, а не замінює його**: доставка
може не відбутись (черга лежить, ваш сервер віддав 4xx), тому
`waitForSignature()` лишається джерелом істини.

Вимоги relay до URL: `https`, стандартний порт, максимум 2048 символів, не в
приватну мережу. Інакше — 400 `invalid_callback_url` (SDK кине `invalid_request`
із причиною в `message`).

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

### Перевірка підпису — обов'язкова

Без перевірки `X-Relay-Signature` ваш ендпоінт приймає підроблений колбек від
будь-кого, хто дізнався URL: "цю транзакцію підписано" — і DEX відпускає товар.
Секрет — той самий, що у relay в `WEBHOOK_SIGNING_SECRET`.

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

## Формат `txParams`

Той самий об'єкт, що приймає `prepareSignedTx` із
[`minter-js-sdk`](https://github.com/MinterTeam/minter-js-sdk) — SDK нічого в
ньому не змінює, лише шифрує для передачі гаманцю.

**Важливо:** на відміну від `Minter.postTx()` (який сам резолвить символ монети
в `coinId` через мережу), підпис виконує гаманець функцією `prepareSignedTx()` —
вона працює локально й **не вміє** перетворити `'MNT'` на числовий `coinId`.
Це має зробити ваш бекенд ще до виклику `sign()`:

```typescript
import { Minter } from 'minter-js-sdk';

// baseURL вкажіть ПОВНІСТЮ, разом із версійним префіксом, який дає ваш
// провайдер ноди — SDK нічого до нього не дописує.
const minter = new Minter({ apiType: 'node', baseURL: process.env.MINTER_NODE_API_URL });
const coinId = await minter.getCoinId('MNT');

const signedTxHex = await session.sign({
  chainId: 1,          // 1 = mainnet, 2 = testnet
  type: '0x01',
  data: { to: 'Mx...', coin: coinId, value: '10' },
  gasCoin: coinId,
});
```

`nonce` можна не вказувати — гаманець підставить актуальний перед підписом.

## Персистентність сесії

Relay тримає підтверджену сесію 7 днів, але ephemeral-ключ ECDH живе лише в
пам'яті інстанса `MinterConnectSession`. Без збереження стану перезавантаження
сторінки вимагає нового пейрінгу — тобто 7-денний TTL обслуговує лише сторону
гаманця, а DEX щоразу починає з нуля.

```typescript
// Перед вивантаженням / після успішного конекту
await store.put('minter-session', encrypt(JSON.stringify(session.serialize())));

// Після перезапуску
const raw = await store.get('minter-session');
if (raw) {
  try {
    const session = await client.restoreSession(JSON.parse(decrypt(raw)));
    if (session.isConnected) {
      // готово: можна одразу sign(), пейрінг не потрібен
    } else {
      // гаманець ще не підтвердив — показуємо session.deepLink і чекаємо
      await session.waitForConnection();
    }
  } catch (err) {
    if (err instanceof MinterConnectError && err.requiresReconnect) {
      await store.delete('minter-session'); // сесії більше немає
    } else throw err;
  }
}
```

`SerializedSession` — це `{ v: 1, sessionId, ephemeralSecretKeyHex }` і більше
нічого. Ані адреса гаманця, ані `handshakeVerified` не зберігаються навмисно:
`restoreSession()` бере їх із `GET /sessions/:sessionId` і **перевіряє доказ
handshake заново**, так само як при першому підключенні. Збережений
`handshakeVerified: true` був би довірою до власного сховища замість підпису
гаманця — відновлення зі сховища тут не слабше за свіжий конект, а не сильніше.

⚠️ `ephemeralSecretKeyHex` — **секрет**. Коштами він не розпоряджається (підписує
лише гаманець), але хто його дістане — розшифрує трафік цієї сесії. Зберігайте
зашифрованим; у браузері не кладіть у `localStorage` як є.

Помилки `restoreSession()`: `session_revoked` / `session_expired` /
`session_not_found` (сесії немає — чистьте сховище і піднімайте новий пейрінг),
`handshake_invalid` (relay підмінив адресу чи ключ — це не лікується ретраєм),
`invalid_request` (битий або чужий формат стану).

## Строки життя

| Що | Скільки | Наслідок |
|---|---|---|
| Pairing (від `createSession()` до підтвердження) | 5 хв | `session_expired` |
| Підтверджена сесія | 7 днів | `session_expired` на будь-який `sign()` |
| Окремий запит на підпис | 90 с | `signing_expired` |

Це дефолти relay; конкретний оператор може їх змінити. Не хардкодьте ці числа —
беріть `session.expiresAt` і покладайтесь на коди помилок.

## Безпека

- Жодна операція SDK не передає й не запитує приватний ключ або сид-фразу.
- Кожна сесія має власний ephemeral-ключ ECDH: компрометація однієї сесії не
  зачіпає інші.
- `session.serialize()` віддає цей ключ назовні — зберігайте результат лише
  зашифрованим (див. «Персистентність сесії»).
- Relay бачить лише шифротекст; розшифрувати може лише той гаманець, для якого
  payload призначений.
- Гаманець завжди показує користувачу людиночитану сводку транзакції перед
  підписом — SDK не може обійти це підтвердження.
- Вхідні вебхуки перевіряйте за HMAC (див. вище). Без цього довіряти їм не можна.

## Розробка

```bash
npm run typecheck   # tsc --noEmit по src і test
npm test            # vitest: крипта, мапінг помилок, поллінг, сумісність із relay
npm run build       # tsc -p tsconfig.build.json -> dist/
npm run test:e2e    # ручний e2e проти живого relay (потрібен піднятий relay)
```

Ручний e2e:

```bash
cd ../minterWallet/minter-backend && docker compose up -d && npm run migrate:up && npm run dev
# в іншому терміналі:
RELAY_URL=http://localhost:3000 npm run test:e2e
```
