#!/usr/bin/env bash
# Nightly reset for the public demo: down → wipe volume → up → reseed. Idempotent.
# Driven by a systemd timer (see scripts/rubymik-demo-reset.timer).
#
# The demo manages ZERO real devices: the single seeded device ("zzz-demo-chr") is
# synthetic (unreachable 10.99.0.1) and shows offline. A live demo device would have to
# be a synthetic RouterOS-REST responder ON demonet — the qemu CHR image cannot run on an
# `internal: true` network (it requires a default route). See docs/P41-PENDING-RAY.md.
#
#   Admin password: /opt/rubymik-demo/.admin-pass (root-only, held by Ray — NOT published).
#   Viewer "demo@rubymik.com" password is published.
set -uo pipefail
cd "$(dirname "$0")/.." 2>/dev/null || cd /opt/rubymik-demo
COMPOSE="docker compose -f docker-compose.demo.yml"
ADMIN_PASS="$(cat /opt/rubymik-demo/.admin-pass 2>/dev/null || echo "ChangeMe-fallback")"
DEMO_VIEWER_PASS="${RUBYMIK_DEMO_VIEWER_PASS:-rubymik-demo}"   # published

echo "[$(date -u +%FT%TZ)] demo reset: recreate + wipe the demo service ONLY (leave the tunnel running)"
$COMPOSE stop demo >/dev/null 2>&1 || true
$COMPOSE rm -fsv demo >/dev/null 2>&1 || true                    # -v drops the anonymous /offhost volume too
docker volume rm rubymikdemo_demo-data >/dev/null 2>&1 || true   # wipe the named data volume

echo "up demo"
$COMPOSE up -d demo 2>&1 | tail -2

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
# published VIEWER account
curl -s -b "$J" -o /dev/null -X POST "$BASE/api/users" -H 'content-type: application/json' \
  -d "{\"email\":\"demo@rubymik.com\",\"role\":\"viewer\",\"password\":\"$DEMO_VIEWER_PASS\"}"
# the ONLY managed device: synthetic + unreachable (shows offline). Manages ZERO real devices.
curl -s -b "$J" -o /dev/null -X POST "$BASE/api/devices" -H 'content-type: application/json' \
  -d '{"name":"zzz-demo-chr","host":"10.99.0.1","username":"admin","password":"","writeUsername":"admin","writePassword":""}'
rm -f "$J"
echo "[$(date -u +%FT%TZ)] demo reset complete"
