# Changelog

Все заметные изменения пакета `minter-connect-sdk`. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

Пакет ставится из GitHub по тегу версии:

```bash
npm install github:Atikoz/minter-connect-sdk#v2.0.0
```

## [Unreleased]

Изменения только в демо и инструментах разработки, сам пакет не менялся.

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

[Unreleased]: https://github.com/Atikoz/minter-connect-sdk/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Atikoz/minter-connect-sdk/compare/9b7865c...v2.0.0
[1.0.0]: https://github.com/Atikoz/minter-connect-sdk/commit/9b7865c
