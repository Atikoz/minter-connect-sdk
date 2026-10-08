#!/usr/bin/env bash
# Піднімає весь стек для живого тесту з гаманцем у Telegram:
#   Postgres + Redis (docker compose бекенду) → міграції →
#   3 тунелі cloudflared (relay, гаманець, демо) → relay → Mini App гаманця → демо SDK.
#
#   WALLET_APP_LINK=https://t.me/<Bot>/<short> npm run dev:stack
#
# Змінні:
#   WALLET_APP_LINK  (обов'язкова) Direct Link Mini App з BotFather
#   MINTER_NODE_URL  Minter Node API v2 (…/v2) — лише для кнопки «Відправити»
#   WITH_WORKER=1    запустити ще й worker бекенду (вебхуки, прибирання)
#   SKIP_DB=1        не чіпати docker: Postgres/Redis уже підняті вами
#   BACKEND_DIR / WALLET_DIR  шляхи до чекаутів (за замовчуванням ../minterWallet/…)
#   RELAY_PORT=3000 WALLET_PORT=5173 DEMO_PORT=8787
#   RELAY_PUBLIC_URL / WALLET_PUBLIC_URL / DEMO_PUBLIC_URL
#                    власні публічні https-адреси (ngrok, іменований тунель),
#                    які вже ведуть на відповідні порти. Для заданої адреси
#                    quick-тунель cloudflared не запускається.
#
# Ctrl+C зупиняє все, що запустив скрипт (крім контейнерів БД — їх зупиняє
# `docker compose down` у теці бекенду).

set -euo pipefail
set -m # кожен фоновий процес — у своїй групі, щоб убити його разом із дітьми

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
    say "зупиняю процеси…"
    for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------- перевірки

[[ -n "${WALLET_APP_LINK:-}" ]] || die "задайте WALLET_APP_LINK=https://t.me/<Bot>/<short> (Direct Link з BotFather)"
[[ "$WALLET_APP_LINK" =~ ^https://t\.me/[A-Za-z0-9_]+/[A-Za-z0-9_]+$ ]] \
  || die "WALLET_APP_LINK має виглядати як https://t.me/<Bot>/<short>, отримано: $WALLET_APP_LINK"
[[ -d "$BACKEND_DIR" ]] || die "немає бекенду: $BACKEND_DIR (задайте BACKEND_DIR)"
[[ -d "$WALLET_DIR" ]] || die "немає гаманця: $WALLET_DIR (задайте WALLET_DIR)"
if [[ -z "${RELAY_PUBLIC_URL:-}" || -z "${WALLET_PUBLIC_URL:-}" || -z "${DEMO_PUBLIC_URL:-}" ]]; then
  command -v cloudflared >/dev/null || die "потрібен cloudflared (brew install cloudflared) або власні *_PUBLIC_URL"
fi
for dir in "$SDK_DIR" "$BACKEND_DIR" "$WALLET_DIR"; do
  [[ -d "$dir/node_modules" ]] || die "немає node_modules у $dir — виконайте там npm install"
done
for port in "$RELAY_PORT" "$WALLET_PORT" "$DEMO_PORT"; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then die "порт $port зайнятий"; fi
done

mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log

# ------------------------------------------------------------- база даних

wait_port() { # host port name timeout
  local i
  for ((i = 0; i < $4; i++)); do
    if nc -z "$1" "$2" 2>/dev/null; then return 0; fi
    sleep 1
  done
  die "$3 не піднявся на $1:$2 за $4 с"
}

if [[ "${SKIP_DB:-}" != 1 ]]; then
  docker info >/dev/null 2>&1 || die "Docker не запущений. Запустіть Docker Desktop або підніміть Postgres/Redis самі і передайте SKIP_DB=1"
  say "Postgres і Redis (docker compose)…"
  (cd "$BACKEND_DIR" && docker compose up -d) >"$LOG_DIR/docker.log" 2>&1 || die "docker compose up не вдався, див. $LOG_DIR/docker.log"
fi
wait_port localhost 5432 Postgres 60
wait_port localhost 6379 Redis 30

say "міграції…"
migrated=0
for _ in 1 2 3 4 5; do # Postgres відкриває порт трохи раніше, ніж приймає з'єднання
  if (cd "$BACKEND_DIR" && npm run --silent migrate:up) >"$LOG_DIR/migrate.log" 2>&1; then migrated=1; break; fi
  sleep 2
done
((migrated)) || die "міграції не пройшли, див. $LOG_DIR/migrate.log"

# ---------------------------------------------------------------- тунелі

start() { # name dir command...
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && exec "$@") >"$LOG_DIR/$name.log" 2>&1 &
  PIDS+=("$!")
}

tunnel_url() { # name
  local i url log="$LOG_DIR/tunnel-$1.log"
  for ((i = 0; i < 45; i++)); do
    # api.trycloudflare.com теж трапляється в лозі (у повідомленнях про помилки).
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | grep -v '^https://api\.' | head -1 || true)"
    if [[ -n "$url" ]]; then echo "$url"; return 0; fi
    if grep -q 'failed to request quick Tunnel' "$log" 2>/dev/null; then
      die "cloudflared не зміг створити quick-тунель $1 (api.trycloudflare.com недоступний з вашої мережі?)." \
        "Див. $log; або передайте власні RELAY_PUBLIC_URL / WALLET_PUBLIC_URL / DEMO_PUBLIC_URL"
    fi
    sleep 1
  done
  die "тунель $1 не видав адресу, див. $log"
}

public_url() { # name port scheme existing-url
  if [[ -n "$4" ]]; then
    [[ "$4" =~ ^https:// ]] || die "$1: публічна адреса має бути https, отримано: $4"
    echo "${4%/}"
    return 0
  fi
  local extra=()
  # Гаманець у дев-режимі віддає https із самопідписаним сертифікатом (plugin-basic-ssl).
  [[ "$3" == https ]] && extra=(--no-tls-verify)
  start "tunnel-$1" "$SDK_DIR" cloudflared tunnel --no-autoupdate ${extra[@]+"${extra[@]}"} --url "$3://localhost:$2"
}

say "публічні адреси…"
public_url relay "$RELAY_PORT" http "${RELAY_PUBLIC_URL:-}" >/dev/null
public_url wallet "$WALLET_PORT" https "${WALLET_PUBLIC_URL:-}" >/dev/null
public_url demo "$DEMO_PORT" http "${DEMO_PUBLIC_URL:-}" >/dev/null
RELAY_PUBLIC="${RELAY_PUBLIC_URL:-$(tunnel_url relay)}"
WALLET_PUBLIC="${WALLET_PUBLIC_URL:-$(tunnel_url wallet)}"
DEMO_PUBLIC="${DEMO_PUBLIC_URL:-$(tunnel_url demo)}"
RELAY_PUBLIC="${RELAY_PUBLIC%/}" WALLET_PUBLIC="${WALLET_PUBLIC%/}" DEMO_PUBLIC="${DEMO_PUBLIC%/}"

# ---------------------------------------------------------------- relay

say "relay…"
# Змінні оточення мають пріоритет над .env (dotenv не перезаписує наявні),
# тож .env бекенду лишається як є. WALLET_MINI_APP_URL іде в кнопку web_app
# пуша, а їй потрібна https-адреса самого застосунку, не Direct Link t.me.
# SESSION_TTL_MS — 7 днів замість 2 хв із .env.
start relay "$BACKEND_DIR" env \
  PORT="$RELAY_PORT" \
  WALLET_MINI_APP_URL="$WALLET_PUBLIC" \
  SESSION_TTL_MS=604800000 \
  npm run dev
if [[ "${WITH_WORKER:-}" == 1 ]]; then
  start worker "$BACKEND_DIR" npm run dev:worker
fi

# ---------------------------------------------------------------- гаманець

# VITE_RELAY_URL читається на старті Vite, тому пишемо його до запуску.
# Інші рядки .env.local не чіпаємо.
ENV_LOCAL="$WALLET_DIR/.env.local"
touch "$ENV_LOCAL"
grep -v '^VITE_RELAY_URL=' "$ENV_LOCAL" >"$ENV_LOCAL.tmp" || true
echo "VITE_RELAY_URL=$RELAY_PUBLIC" >>"$ENV_LOCAL.tmp"
mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"

say "Mini App гаманця…"
# vite.config дозволяє лише *.trycloudflare.com; власний хост гаманця додаємо
# штатною змінною Vite, не чіпаючи конфіг.
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

# ------------------------------------------------------------ готовність

wait_http() { # name url [hint]
  local i
  for ((i = 0; i < 60; i++)); do
    if curl -skf -m 3 -o /dev/null "$2"; then return 0; fi
    sleep 1
  done
  die "$1 не відповідає на $2, ${3:-див. $LOG_DIR/$1.log}"
}
wait_http relay "http://localhost:$RELAY_PORT/healthz"
wait_http wallet "https://localhost:$WALLET_PORT/"
wait_http demo "http://localhost:$DEMO_PORT/minter-connect-manifest.json"
# Публічні адреси: саме ними користуються телефон і relay. DNS нового
# quick-тунелю інколи з'являється із затримкою.
wait_http relay "$RELAY_PUBLIC/livez" "локально relay працює — перевірте, що публічна адреса веде на порт $RELAY_PORT"
wait_http demo "$DEMO_PUBLIC/minter-connect-manifest.json" "локально демо працює — перевірте, що публічна адреса веде на порт $DEMO_PORT"

cat <<EOF

$(printf '\033[1;32m')Стек піднято.$(printf '\033[0m')

  1. BotFather → /myapps → ваш Mini App → Edit Web App URL:
       $WALLET_PUBLIC
     (адреса quick-тунелю нова при кожному запуску — оновлюйте її щоразу)

  2. Відкрийте демо на комп'ютері і відскануйте QR телефоном:
       $DEMO_PUBLIC

  relay:   $RELAY_PUBLIC   (VITE_RELAY_URL записано в $ENV_LOCAL)
  гаманець: $WALLET_PUBLIC
  логи:    $LOG_DIR/*.log
  ${MINTER_NODE_URL:+node:    $MINTER_NODE_URL}${MINTER_NODE_URL:-«Відправити» вимкнено: задайте MINTER_NODE_URL}

Ctrl+C — зупинити все.
EOF

# Якщо будь-який процес упав — зупиняємо решту, а не висимо з половиною стеку.
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then die "один із процесів завершився (pid $pid), див. $LOG_DIR/*.log"; fi
  done
  sleep 2
done
