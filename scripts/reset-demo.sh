#!/usr/bin/env bash
# Nightly reset for the public demo: down → wipe volume → reseed from fixture → up.
# Driven by a systemd timer (see scripts/rubymik-demo-reset.timer). Idempotent.
#   Admin password: read from /opt/rubymik-demo/.admin-pass (root-only, set once by
#   Ray — NOT published). Viewer "demo@rubymik.com" password is published.
set -uo pipefail
cd "$(dirname "$0")/.." 2>/dev/null || cd /opt/rubymik-demo
COMPOSE="docker compose -f docker-compose.demo.yml"
BASE="http://127.0.0.1:8093"
ADMIN_PASS="$(cat /opt/rubymik-demo/.admin-pass 2>/dev/null || echo "ChangeMe-$(head -c9 /dev/urandom | base64 | tr -dc A-Za-z0-9)")"
DEMO_VIEWER_PASS="${RUBYMIK_DEMO_VIEWER_PASS:-rubymik-demo}"   # published

echo "[$(date -u +%FT%TZ)] demo reset: down + wipe"
$COMPOSE down -v >/dev/null 2>&1 || true

echo "up (demo + chr)"
$COMPOSE --profile chr up -d 2>&1 | tail -2

echo "wait for demo health"
for i in $(seq 1 60); do curl -sf "$BASE/api/health" >/dev/null 2>&1 && break; sleep 2; done

echo "seed: admin (held by Ray) + published viewer + the CHR device"
J=$(mktemp)
curl -s -c "$J" -o /dev/null -X POST "$BASE/api/setup" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@rubymik.com\",\"password\":\"$ADMIN_PASS\"}"
curl -s -b "$J" -c "$J" -o /dev/null -X POST "$BASE/api/login" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@rubymik.com\",\"password\":\"$ADMIN_PASS\"}"
# published VIEWER account
curl -s -b "$J" -o /dev/null -X POST "$BASE/api/users" -H 'content-type: application/json' \
  -d "{\"email\":\"demo@rubymik.com\",\"role\":\"viewer\",\"password\":\"$DEMO_VIEWER_PASS\"}"
# add the CHR as the ONLY managed device (reachable on demonet as 'chr'); creds are the
# CHR's seeded admin. Manage read+write so the demo can show config panels.
curl -s -b "$J" -o /dev/null -X POST "$BASE/api/devices" -H 'content-type: application/json' \
  -d '{"name":"zzz-demo-chr","host":"chr","username":"admin","password":"","writeUsername":"admin","writePassword":""}'

echo "seed CHR synthetic config (zzz-*) via its REST — best effort (CHR may still be booting under TCG)"
CHR=http://chr/rest
for i in $(seq 1 30); do docker exec rubymik-demo curl -s -u admin: "$CHR/system/resource" >/dev/null 2>&1 && break; sleep 4; done || true
docker exec rubymik-demo sh -c "
  curl -s -u admin: -X PUT $CHR/ip/pool -d '{\"name\":\"zzz-pool\",\"ranges\":\"10.99.0.10-10.99.0.50\"}' >/dev/null 2>&1
  curl -s -u admin: -X PUT $CHR/interface/bridge -d '{\"name\":\"zzz-lan\",\"comment\":\"demo\"}' >/dev/null 2>&1
  curl -s -u admin: -X PUT $CHR/ip/dhcp-server/lease -d '{\"address\":\"10.99.0.20\",\"mac-address\":\"AA:BB:CC:00:00:20\",\"comment\":\"zzz-demo\"}' >/dev/null 2>&1
" 2>/dev/null || true
rm -f "$J"
echo "[$(date -u +%FT%TZ)] demo reset complete"
