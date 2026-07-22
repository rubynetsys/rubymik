#!/usr/bin/env bash
# Nightly reset for the public demo: down → wipe volume → up → reseed. Idempotent.
# Driven by a systemd timer (see scripts/rubymik-demo-reset.timer).
#
# The demo manages ZERO real devices: the single seeded device ("zzz-demo-gw") is a
# SYNTHETIC RouterOS-REST responder (service `router`, fabricated data) — it lets the
# dashboard/traffic/topology populate without any real router, KVM or the qemu CHR (which
# can't run on an `internal: true` network). See server/src/devtools/demo-router.ts.
#
#   Admin password: /opt/rubymik-demo/.admin-pass (root-only, held by Ray — NOT published).
#   Viewer "demo@rubymik.com" password is published.
set -uo pipefail
cd "$(dirname "$0")/.." 2>/dev/null || cd /opt/rubymik-demo
COMPOSE="docker compose -f docker-compose.demo.yml"
# SINGLE SOURCE: .env feeds both the app container (the login card) AND this seed, so the
# advertised viewer login can never drift from the one actually created.
set -a; [ -f /opt/rubymik-demo/.env ] && . /opt/rubymik-demo/.env; set +a
ADMIN_PASS="$(cat /opt/rubymik-demo/.admin-pass 2>/dev/null || echo "ChangeMe-fallback")"
DEMO_VIEWER_EMAIL="${RUBYMIK_DEMO_VIEWER_EMAIL:-demo@rubymik.com}"   # published (matches the card)
DEMO_VIEWER_PASS="${RUBYMIK_DEMO_VIEWER_PASS:-rubymik-demo}"         # published (matches the card)

echo "[$(date -u +%FT%TZ)] demo reset: recreate + wipe the demo service ONLY (leave the tunnel running)"
$COMPOSE stop demo >/dev/null 2>&1 || true
$COMPOSE rm -fsv demo >/dev/null 2>&1 || true                    # -v drops the anonymous /offhost volume too
docker volume rm rubymikdemo_demo-data >/dev/null 2>&1 || true   # wipe the named data volume

echo "up demo + synthetic router (leave the tunnel running)"
$COMPOSE up -d demo router 2>&1 | tail -3

# demonet is internal → published ports don't wire up; reach the app on its bridge IP.
echo "resolve demo container IP on demonet + wait for health"
BASE=""
for i in $(seq 1 60); do
  IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' rubymik-demo 2>/dev/null)
  [ -n "$IP" ] && curl -sf "http://$IP:8080/api/health" >/dev/null 2>&1 && { BASE="http://$IP:8080"; break; }
  sleep 2
done
echo "  BASE=$BASE"
[ -n "$BASE" ] || { echo "demo did not become healthy — abort seed"; exit 1; }

echo "seed: admin (held by Ray) + published viewer + synthetic offline device"
J=$(mktemp)
curl -s -c "$J" -o /dev/null -X POST "$BASE/api/setup" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@rubymik.com\",\"password\":\"$ADMIN_PASS\"}"
curl -s -b "$J" -c "$J" -o /dev/null -X POST "$BASE/api/login" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@rubymik.com\",\"password\":\"$ADMIN_PASS\"}"
# published VIEWER account — email+password come from .env, exactly what the login card shows
curl -s -b "$J" -o /dev/null -X POST "$BASE/api/users" -H 'content-type: application/json' \
  -d "{\"email\":\"$DEMO_VIEWER_EMAIL\",\"role\":\"viewer\",\"password\":\"$DEMO_VIEWER_PASS\"}"
# the ONLY managed device: the synthetic responder (http://router:8080). Fabricated data,
# manages ZERO real devices. read-only creds (no write creds → not manageable in the UI).
curl -s -b "$J" -o /dev/null -X POST "$BASE/api/devices" -H 'content-type: application/json' \
  -d '{"name":"zzz-demo-gw","host":"router","port":8080,"useTls":false,"username":"demo","password":"demo"}'
rm -f "$J"
echo "[$(date -u +%FT%TZ)] demo reset complete"
