#!/usr/bin/env bash
# Поднимает весь стек для живого теста с кошельком в Telegram:
#   Postgres + Redis (docker compose бэкенда) → миграции →
#   3 туннеля cloudflared (relay, кошелёк, демо) → relay → Mini App кошелька → демо SDK.
#
#   WALLET_APP_LINK=https://t.me/<Bot>/<short> npm run dev:stack
#
# Переменные:
#   WALLET_APP_LINK  (обязательная) Direct Link Mini App из BotFather
#   MINTER_NODE_URL  Minter Node API v2 (…/v2) — только для кнопки «Отправить»
#   WITH_WORKER=1    запустить ещё и worker бэкенда (вебхуки, уборка)
#   SKIP_DB=1        не трогать docker: Postgres/Redis уже подняты вами
#   BACKEND_DIR / WALLET_DIR  пути к чекаутам (по умолчанию ../minterWallet/…)
#   RELAY_PORT=3000 WALLET_PORT=5173 DEMO_PORT=8787
#   RELAY_PUBLIC_URL / WALLET_PUBLIC_URL / DEMO_PUBLIC_URL
#                    собственные публичные https-адреса (ngrok, именованный туннель),
#                    которые уже ведут на соответствующие порты. Для заданного адреса
#                    quick-туннель cloudflared не запускается.
#
# Ctrl+C останавливает всё, что запустил скрипт (кроме контейнеров БД — их останавливает
# `docker compose down` в папке бэкенда).

set -euo pipefail
set -m # каждый фоновый процесс — в своей группе, чтобы убить его вместе с детьми

SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$SDK_DIR/../minterWallet/minter-backend}"
WALLET_DIR="${WALLET_DIR:-$SDK_DIR/../minterWallet/minter-wallet-miniapp}"
RELAY_PORT="${RELAY_PORT:-3000}"
WALLET_PORT="${WALLET_PORT:-5173}"
DEMO_PORT="${DEMO_PORT:-8787}"
LOG_DIR="$SDK_DIR/.dev-stack"
PIDS=()

say() { printf '\033[1;34m[stack]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[stack]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  trap - EXIT INT TERM
  if ((${#PIDS[@]})); then
    say "останавливаю процессы…"
    for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------- проверки

[[ -n "${WALLET_APP_LINK:-}" ]] || die "задайте WALLET_APP_LINK=https://t.me/<Bot>/<short> (Direct Link из BotFather)"
[[ "$WALLET_APP_LINK" =~ ^https://t\.me/[A-Za-z0-9_]+/[A-Za-z0-9_]+$ ]] \
  || die "WALLET_APP_LINK должен выглядеть как https://t.me/<Bot>/<short>, получено: $WALLET_APP_LINK"
[[ -d "$BACKEND_DIR" ]] || die "нет бэкенда: $BACKEND_DIR (задайте BACKEND_DIR)"
[[ -d "$WALLET_DIR" ]] || die "нет кошелька: $WALLET_DIR (задайте WALLET_DIR)"
if [[ -z "${RELAY_PUBLIC_URL:-}" || -z "${WALLET_PUBLIC_URL:-}" || -z "${DEMO_PUBLIC_URL:-}" ]]; then
  command -v cloudflared >/dev/null || die "нужен cloudflared (brew install cloudflared) или собственные *_PUBLIC_URL"
fi
for dir in "$SDK_DIR" "$BACKEND_DIR" "$WALLET_DIR"; do
  [[ -d "$dir/node_modules" ]] || die "нет node_modules в $dir — выполните там npm install"
done
for port in "$RELAY_PORT" "$WALLET_PORT" "$DEMO_PORT"; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then die "порт $port занят"; fi
done

mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log

# ------------------------------------------------------------- база данных

wait_port() { # host port name timeout
  local i
  for ((i = 0; i < $4; i++)); do
    if nc -z "$1" "$2" 2>/dev/null; then return 0; fi
    sleep 1
  done
  die "$3 не поднялся на $1:$2 за $4 с"
}

if [[ "${SKIP_DB:-}" != 1 ]]; then
  docker info >/dev/null 2>&1 || die "Docker не запущен. Запустите Docker Desktop или поднимите Postgres/Redis сами и передайте SKIP_DB=1"
  say "Postgres и Redis (docker compose)…"
  (cd "$BACKEND_DIR" && docker compose up -d) >"$LOG_DIR/docker.log" 2>&1 || die "docker compose up не удался, см. $LOG_DIR/docker.log"
fi
wait_port localhost 5432 Postgres 60
wait_port localhost 6379 Redis 30

say "миграции…"
migrated=0
for _ in 1 2 3 4 5; do # Postgres открывает порт чуть раньше, чем принимает соединения
  if (cd "$BACKEND_DIR" && npm run --silent migrate:up) >"$LOG_DIR/migrate.log" 2>&1; then migrated=1; break; fi
  sleep 2
done
((migrated)) || die "миграции не прошли, см. $LOG_DIR/migrate.log"

# ---------------------------------------------------------------- туннели

start() { # name dir command...
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && exec "$@") >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=("$!")
}

tunnel_url() { # name
  local i url log="$LOG_DIR/tunnel-$1.log"
  for ((i = 0; i < 45; i++)); do
    # api.trycloudflare.com тоже встречается в логе (в сообщениях об ошибках).
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | grep -v '^https://api\.' | head -1 || true)"
    if [[ -n "$url" ]]; then echo "$url"; return 0; fi
    if grep -q 'failed to request quick Tunnel' "$log" 2>/dev/null; then
      die "cloudflared не смог создать quick-туннель $1 (api.trycloudflare.com недоступен из вашей сети?)." \
        "См. $log; или передайте собственные RELAY_PUBLIC_URL / WALLET_PUBLIC_URL / DEMO_PUBLIC_URL"
    fi
    sleep 1
  done
  die "туннель $1 не выдал адрес, см. $log"
}

public_url() { # name port scheme existing-url
  if [[ -n "$4" ]]; then
    [[ "$4" =~ ^https:// ]] || die "$1: публичный адрес должен быть https, получено: $4"
    echo "${4%/}"
    return 0
  fi
  local extra=()
  # Кошелёк в dev-режиме отдаёт https с самоподписанным сертификатом (plugin-basic-ssl).
  [[ "$3" == https ]] && extra=(--no-tls-verify)
  start "tunnel-$1" "$SDK_DIR" cloudflared tunnel --no-autoupdate ${extra[@]+"${extra[@]}"} --url "$3://localhost:$2"
}

say "публичные адреса…"
public_url relay "$RELAY_PORT" http "${RELAY_PUBLIC_URL:-}" >/dev/null
public_url wallet "$WALLET_PORT" https "${WALLET_PUBLIC_URL:-}" >/dev/null
public_url demo "$DEMO_PORT" http "${DEMO_PUBLIC_URL:-}" >/dev/null
RELAY_PUBLIC="${RELAY_PUBLIC_URL:-$(tunnel_url relay)}"
WALLET_PUBLIC="${WALLET_PUBLIC_URL:-$(tunnel_url wallet)}"
DEMO_PUBLIC="${DEMO_PUBLIC_URL:-$(tunnel_url demo)}"
RELAY_PUBLIC="${RELAY_PUBLIC%/}" WALLET_PUBLIC="${WALLET_PUBLIC%/}" DEMO_PUBLIC="${DEMO_PUBLIC%/}"

# ---------------------------------------------------------------- relay

say "relay…"
# Переменные окружения имеют приоритет над .env (dotenv не перезаписывает существующие),
# поэтому .env бэкенда остаётся как есть. WALLET_MINI_APP_URL идёт в кнопку web_app
# пуша, а ей нужен https-адрес самого приложения, не Direct Link t.me.
# SESSION_TTL_MS — 7 дней вместо 2 мин из .env.
start relay "$BACKEND_DIR" env \
  PORT="$RELAY_PORT" \
  WALLET_MINI_APP_URL="$WALLET_PUBLIC" \
  SESSION_TTL_MS=604800000 \
  npm run dev
if [[ "${WITH_WORKER:-}" == 1 ]]; then
  start worker "$BACKEND_DIR" npm run dev:worker
fi

# ---------------------------------------------------------------- кошелёк

# VITE_RELAY_URL читается при старте Vite, поэтому пишем его до запуска.
# Остальные строки .env.local не трогаем.
ENV_LOCAL="$WALLET_DIR/.env.local"
touch "$ENV_LOCAL"
grep -v '^VITE_RELAY_URL=' "$ENV_LOCAL" >"$ENV_LOCAL.tmp" || true
echo "VITE_RELAY_URL=$RELAY_PUBLIC" >>"$ENV_LOCAL.tmp"
mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"

say "Mini App кошелька…"
# vite.config разрешает только *.trycloudflare.com; собственный хост кошелька добавляем
# штатной переменной Vite, не трогая конфиг.
WALLET_HOST="${WALLET_PUBLIC#https://}"
WALLET_HOST="${WALLET_HOST%%/*}"
start wallet "$WALLET_DIR" env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="${WALLET_HOST%%:*}" \
  npx vite --port "$WALLET_PORT" --strictPort

# ---------------------------------------------------------------- демо

say "демо SDK…"
start demo "$SDK_DIR" env \
  PORT="$DEMO_PORT" \
  PUBLIC_URL="$DEMO_PUBLIC" \
  RELAY_URL="$RELAY_PUBLIC" \
  WALLET_APP_LINK="$WALLET_APP_LINK" \
  ${MINTER_NODE_URL:+MINTER_NODE_URL="$MINTER_NODE_URL"} \
  npx tsx demo/server.ts

# ------------------------------------------------------------ готовность

wait_http() { # name url [hint]
  local i
  for ((i = 0; i < 60; i++)); do
    if curl -skf -m 3 -o /dev/null "$2"; then return 0; fi
    sleep 1
  done
  die "$1 не отвечает на $2, ${3:-см. $LOG_DIR/$1.log}"
}
wait_http relay "http://localhost:$RELAY_PORT/healthz"
wait_http wallet "https://localhost:$WALLET_PORT/"
wait_http demo "http://localhost:$DEMO_PORT/minter-connect-manifest.json"
# Публичные адреса: именно ими пользуются телефон и relay. DNS нового
# quick-туннеля иногда появляется с задержкой.
wait_http relay "$RELAY_PUBLIC/livez" "локально relay работает — проверьте, что публичный адрес ведёт на порт $RELAY_PORT"
wait_http demo "$DEMO_PUBLIC/minter-connect-manifest.json" "локально демо работает — проверьте, что публичный адрес ведёт на порт $DEMO_PORT"

cat <<EOF

$(printf '\033[1;32m')Стек поднят.$(printf '\033[0m')

  1. BotFather → /myapps → ваш Mini App → Edit Web App URL:
       $WALLET_PUBLIC
     (адрес quick-туннеля новый при каждом запуске — обновляйте его каждый раз)

  2. Откройте демо на компьютере и отсканируйте QR телефоном:
       $DEMO_PUBLIC

  relay:   $RELAY_PUBLIC   (VITE_RELAY_URL записан в $ENV_LOCAL)
  кошелёк: $WALLET_PUBLIC
  логи:    $LOG_DIR/*.log
  ${MINTER_NODE_URL:+node:    $MINTER_NODE_URL}${MINTER_NODE_URL:-«Отправить» отключено: задайте MINTER_NODE_URL}

Ctrl+C — остановить всё.
EOF

# Если любой процесс упал — останавливаем остальные, а не висим с половиной стека.
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then die "один из процессов завершился (pid $pid), см. $LOG_DIR/*.log"; fi
  done
  sleep 2
done
