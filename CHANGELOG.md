# Changelog

Все заметные изменения пакета `minter-connect-sdk`. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

Пакет ставится из GitHub по тегу версии:

```bash
npm install github:Atikoz/minter-connect-sdk#v2.3.0
```

## [Unreleased]

## [2.3.0] — 2026-10-26

Совместимо с 2.2: только добавления.

### Добавлено

- `session.burnToken({ amount, coin })` и `session.requestBurnToken(...)` — запрос
  кошельку на сжигание монеты СО СВОЕГО адреса (BURN_TOKEN, тип 0x1D). Результат
  такой же, как у перевода: `signedTxHex`, отправляет в сеть сайт. На проводе —
  `{ v: 1, method: 'burnToken', params: { amount, coin } }`; правила для `amount`
  и `coin` те же, что у `sendTransaction`, лишние поля (включая `to`) — `invalid_request`.
- Тип `BurnTokenParams`.

Кошелёк, который метод `burnToken` ещё не поддерживает, ответит `wallet_bad_request`.

## [2.2.0] — 2026-10-14

Совместимо с 2.1 по API SDK: обновление — та же команда установки с тегом `#v2.2.0`.
**Но если вы принимаете вебхуки — прочитайте «Важно» ниже.**

### Важно: вебхуки подписываются секретом сессии

Relay больше не подписывает вебхуки общим `WEBHOOK_SIGNING_SECRET`: его пришлось
бы раздать всем DEX, и любой из них мог бы подделать «signed»-колбэк для чужого
сайта. Теперь у каждой сессии свой секрет — relay отдаёт его один раз в ответе
`POST /sessions` (только если передан `callbackUrl`).

Что сделать:

1. Сохраняйте `session.serialize()` — секрет теперь входит в состояние
   (`webhookSecret`).
2. В обработчике вебхука берите `sessionId` из тела, находите **свой**
   сохранённый `webhookSecret` этой сессии и проверяйте `X-Relay-Signature` им
   (пример — README → «Вебхуки»). Неизвестный `sessionId` — 401.
3. Сессии, созданные до обновления relay, секрета не имеют: их вебхуки
   проверить нечем — переподключите такие сессии.

Старая проверка общим секретом после обновления relay перестанет проходить:
колбэки будут отвергаться вашим же эндпоинтом (поллинг `waitForSignature()`
продолжит работать).

### Добавлено

- `session.webhookSecret` — ключ проверки вебхуков этой сессии; `undefined`,
  если сессия без `callbackUrl` или relay не подписывает вебхуки.
- `webhookSecret` в `SerializedSession` (необязательное поле, формат остаётся
  `v: 2`) — восстанавливается через `restoreSession()`. Битое значение даёт
  `invalid_request`.

### Изменено

- `new MinterConnectClient()` сразу бросает `invalid_request` на невалидный
  `relayUrl` (не http(s), с query или fragment). Раньше это проявлялось только
  как `network_error` на первом запросе.
- Ответ relay на `POST /sessions` без `sessionId` и на `POST /sessions/:id/requests`
  без `reqId` даёт `relay_error`, а не сессию или запрос, которые не заработают.
- `sessionId` из сохранённого состояния и `reqId` от интегратора кодируются в
  пути запроса: битое состояние больше не может поменять маршрут.

### Внутреннее

- Рефакторинг `session.ts` без изменения API: общая обработка терминальных
  статусов, один метод запросов к relay, ключ канала без non-null утверждений,
  именованные интервалы поллинга, единый дефолт паузы на 429.

## [2.1.0] — 2026-10-12

Совместимо с 2.0: обновление — та же команда установки с тегом `#v2.1.0`.

### Устарело

- Опция `requireHandshakeProof` (будет удалена в 3.0). Текущий relay всегда
  отдаёт доказательство handshake, а `false` лишь выключает проверку подписи
  кошелька: relay мог бы подменить адрес или ключ канала. Опция по-прежнему
  работает, но помечена `@deprecated` в типах, а при `false` SDK один раз
  пишет предупреждение в консоль. Что сделать: убрать опцию из конфига.
- Ошибка `handshake_unverifiable` больше не советует передать
  `requireHandshakeProof: false`, а предлагает обновить relay.

### Исправлено

- Демо: ошибки подключения видны на странице. Раньше текст писался в ещё скрытый
  блок, и при открытии `demo/index.html` через статический сервер (VS Code Live
  Server, `file://`) кнопка выглядела нерабочей. Теперь страница подсказывает
  запустить `npm run demo`.
- Демо: пустая переменная (`PUBLIC_URL=` в `.env`) считается незаданной, а не
  ломает адрес manifest.
- `npm run dev:stack`: туннели cloudflared работают по `http2`. В сетях, где
  закрыт UDP 7844, QUIC по умолчанию давал Error 1033.

### Добавлено

- Демо читает настройки из `.env` в корне SDK (`process.loadEnvFile`), значения из
  командной строки приоритетнее. Пример — `.env.example`; `.env` в `.gitignore`.

## [2.0.0] — 2026-10-09

SDK приведён к relay с manifest и `dexToken` (контракт: `minter-backend`,
ветка `feat/wallet-dex-auth`, `docs/API.md` и `src/shared/handshake.ts`).
**Несовместим с 1.x и со старым relay.**

### Миграция с 1.x

**1. Конфиг клиента**

```diff
 new MinterConnectClient({
   relayUrl: 'https://relay.example.com',
-  dexName: 'My DEX',
-  walletBotUsername: 'minter_wallet_bot',
+  manifestUrl: 'https://mydex.com/minter-connect-manifest.json',
+  walletAppLink: 'https://t.me/MinterWalletBot/app',
 });
```

- `dexName` убран: название и иконка теперь в manifest на вашем домене —
  `{ "url": "https://mydex.com", "name": "MyDex", "iconUrl": "https://mydex.com/icon.png" }`,
  https, тот же host, что у `manifestUrl`, заголовок `Access-Control-Allow-Origin: *`.
- `walletBotUsername` заменён полным Direct Link Mini App (`walletAppLink`) из
  BotFather. `deepLink` = `<walletAppLink>?startapp=connect_<sessionId>`; раньше
  путь `/app` был зашит в SDK.
- Новое необязательное поле `domain` — собственный домен сайта для проверки
  handshake (по умолчанию host из `manifestUrl`).

**2. Подпись транзакций**

```diff
-const signedTxHex = await session.sign({ chainId: 1, type: '0x01', data: { to, coin: 0, value: '10' } });
+const signedTxHex = await session.sendTransaction({ to: 'Mx…', amount: '10', coin: 'BIP' });
```

| 1.x | 2.0 |
|---|---|
| `sign(txParams)` | `sendTransaction({ to, amount, coin })` |
| `requestSignature(txParams)` | `requestTransaction({ to, amount, coin })` |
| `waitForSignature(reqId)` | без изменений |
| тип `TxParams` | тип `SendTransactionParams` |
| тип `RequestSignatureOptions` | тип `RequestTransactionOptions` |

- `amount` — строка в монетах (не в pip), `coin` — тикер (`'BIP'`), а не `coinId`.
- Nonce, комиссию, `chainId` и `payload` кошелёк определяет сам; передать их нельзя.
- `params` проверяются теми же правилами, что и в кошельке, включая запрет лишних
  полей. Некорректный вызов сразу даёт `invalid_request`, без запроса к relay.
- `signedTxHex` в сеть по-прежнему отправляет сайт (Node API v2 `send_transaction`
  или Gate API).

**3. Сохранённые сессии**

- `SerializedSession` теперь `{ v: 2, sessionId, ephemeralSecretKeyHex, dexToken }`.
  **`dexToken` — секрет**, как и ключ: храните на сервере или в зашифрованном виде.
- Состояние v1 не восстанавливается: `restoreSession()` бросает `invalid_request`
  с пояснением. Relay закрыл те сессии при миграции, нужно новое подключение.

**4. Коды ошибок**

| Новый `code` | Когда | `isRetryable` | `requiresReconnect` |
|---|---|---|---|
| `unauthorized` | 401/403 `missing_dex_token` / `invalid_dex_token` | нет | **да** |
| `invalid_manifest` | 422 `invalid_manifest_url` / `manifest_unreachable` / `manifest_invalid` / `manifest_domain_mismatch` | нет | нет |
| `wallet_bad_request` | кошелёк счёл запрос некорректным, или `rejected` без результата | нет | нет |
| `wallet_signing_failed` | кошелёк не смог подписать (баланс, сеть, монета) | нет | нет |

- `signing_rejected` теперь означает только явный отказ пользователя
  (`user_rejected`). Раньше им становился любой `rejected`, включая отзыв сессии.
- Текст от кошелька — в новом поле `err.walletErrorMessage`.
- 401/403/422 больше не попадают в `relay_error`, который считался временным
  (`isRetryable: true`).
- Лимиты сессии (`too_many_pending_requests`, `session_rate_limited`) → `rate_limited`;
  без `Retry-After` от relay `retryAfterMs` = 5 с.

### Добавлено

- `dexToken` из `POST /sessions` передаётся как `Authorization: Bearer` во все
  запросы сайта к relay; в `deepLink` не попадает никогда.
- Handshake подписывает домен и время:
  `minter-connect:handshake:<sessionId>:<ecdhKey>:<domain>:<issuedAt>`.
  `verifyHandshake` повторяет логику бэкенда (`domain_mismatch` / `stale_proof` /
  `address_mismatch` / `invalid_signature`). Ожидаемый домен берётся только из
  конфига, никогда из ответа relay. Свежесть — 10 мин при подключении; при
  восстановлении сессии не проверяется, домен и подпись проверяются всегда.
- Фиксированные тестовые векторы из бэкенда (`test/fixtures/relay-vectors.json`,
  `npm run fixtures:relay`): CI ловит расхождение контракта без соседнего чекаута.
- Скрипт `prepare`: при установке из git npm сам собирает `dist/`.
- Демо (`demo/`, `npm run demo`) — весь поток с живым кошельком; скрипт
  `npm run dev:stack` поднимает relay, кошелёк и демо с публичными адресами.

### Изменено

- `waitForConnection()` на уже подключённой (восстановленной) сессии сразу
  возвращает результат, без повторной проверки свежести.
- Для локальной разработки `manifestUrl` может быть `http://localhost:<port>`
  (relay в dev-режиме); в остальных случаях только https.
- README, комментарии и сообщения — на русском.

### Удалено

- Пустой `src/db.ts`.

## [1.0.0]

Первая версия: подключение через relay со старым API (`dexName`,
`walletBotUsername`, `sign(txParams)`), без `dexToken` и без домена в handshake.

[Unreleased]: https://github.com/Atikoz/minter-connect-sdk/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/Atikoz/minter-connect-sdk/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Atikoz/minter-connect-sdk/compare/9b7865c...v2.0.0
[1.0.0]: https://github.com/Atikoz/minter-connect-sdk/commit/9b7865c
