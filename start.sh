#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
shared_openrouter_env="$(cd .. && pwd)/.openrouter.env"
if [ -f "$shared_openrouter_env" ]; then set -a; source "$shared_openrouter_env"; set +a; fi
if [ -f .env ]; then set -a; source ./.env; set +a; fi
export UI_HOST="${UI_HOST:-127.0.0.1}"
export API_HOST="${API_HOST:-127.0.0.1}"
export UI_PORT="${UI_PORT:-4553}"
export API_PORT="${API_PORT:-5553}"
export SESSION_SECRET="${SESSION_SECRET:-local-domain-recovery-session-change-before-production}"
export OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-anthropic/claude-haiku-4.5}"
stop_port_listener() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then return 0; fi
  echo "Stopping existing listener(s) on port $port: $pids"
  kill $pids 2>/dev/null || true
  for _ in {1..30}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Force-stopping listener(s) still using port $port: $pids"
    kill -KILL $pids 2>/dev/null || true
  fi
}
stop_port_listener "$UI_PORT"
stop_port_listener "$API_PORT"
if [ -z "${DATABASE_URL:-}" ]; then
  db_user="${PGUSER:-$(id -un)}"
  db_name="profit_ai_parcel_ltl_invoice_audit_recovery"
  if ! psql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='$db_name'" | grep -q 1; then createdb -h 127.0.0.1 -U "$db_user" "$db_name"; fi
  export DATABASE_URL="postgresql://$db_user@127.0.0.1:5432/$db_name"
fi
for migration in backend/migrations/*.sql; do PGOPTIONS='--client-min-messages=warning' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null; done
node backend/scripts/seed.mjs
node backend/server.mjs &
api_pid=$!
ui_pid=""
cleanup(){
  if [ -n "$ui_pid" ]; then kill "$ui_pid" 2>/dev/null || true; fi
  kill "$api_pid" 2>/dev/null || true
  if [ -n "$ui_pid" ]; then wait "$ui_pid" 2>/dev/null || true; fi
  wait "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
ready=0
for _ in {1..60}; do if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then ready=1; break; fi; sleep 0.1; done
if [ "$ready" -ne 1 ]; then echo "API failed to start on port $API_PORT" >&2; exit 1; fi
echo "$(node --input-type=module -e "import('./app.config.mjs').then(m=>console.log(m.default.title))") UI: http://$UI_HOST:$UI_PORT"
echo "API: http://$API_HOST:$API_PORT"
cd frontend
./node_modules/.bin/vite --host "$UI_HOST" --port "$UI_PORT" &
ui_pid=$!
wait "$ui_pid"
