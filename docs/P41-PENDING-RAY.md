# P41 — PENDING-RAY (the manual steps only Ray can do)

Everything RubyMIK could build/deploy is done and running on 165.73.244.111 (localhost-
bound, Gate-0-safe). These are the items that require Cloudflare, the SMTP2GO dashboard,
or a hosting decision — I did **not** touch Cloudflare or existing stacks.

## 1. Cloudflare — routing (rubymik.com is registered but has NO DNS yet)

The host already uses a **token-based cloudflared tunnel** (RubyFinance) with
`TUNNEL_TRANSPORT_PROTOCOL=http2` (QUIC fails on this bridge). Do the same for RubyMIK:

**a. Landing site (rubymik.com):**
1. Cloudflare → Zero Trust → Networks → Tunnels → create tunnel **"rubymik"** (or reuse one).
2. Public hostname: `rubymik.com` (and `www.rubymik.com`) → service `http://rubymik-web:80`.
3. Copy the tunnel **token**, put it in `/opt/rubymik-site/.env` as `RUBYMIK_TUNNEL_TOKEN=…`.
4. `cd /opt/rubymik-site && docker compose -f docker-compose.site.yml --profile tunnel up -d`
   (the cloudflared here already sets `TUNNEL_TRANSPORT_PROTOCOL=http2` and is on the
   `rubymikweb` network with the nginx container). Cloudflare auto-creates the DNS.
5. `https://rubymik.com` + `https://rubymik.com/version.json` go live over HTTPS.

**b. Demo (demo.rubymik.com):** the demo needs its **OWN** cloudflared connector — it
**cannot** be a second public hostname on the site tunnel, because the demo container
lives on `demonet` (`internal: true`) and the site connector is on a different network,
so it physically can't reach `rubymik-demo:8080`. So: create a **separate** tunnel
(e.g. "rubymik-demo"), public hostname `demo.rubymik.com` → service
`http://rubymik-demo:8080`; put its token in `/opt/rubymik-demo/.env` as
`RUBYMIK_DEMO_TUNNEL_TOKEN=…`; then `cd /opt/rubymik-demo && docker compose -f
docker-compose.demo.yml --profile tunnel up -d`. The demo's `tunnel` service is attached
to **both** `demonet` (to reach `demo:8080`) and `tunnelnet` (outbound to Cloudflare),
and the nightly reset now recreates **only** the `demo` service so the connector stays
up. **Also add a Cloudflare rate-limit rule** on demo.rubymik.com (e.g. 60 req/min/IP) —
the phase asks for proxy-level rate limiting and Cloudflare is the proxy. Once it's up,
ping me and I'll verify demo.rubymik.com end-to-end + grab the demo screenshots.

> `version.json` is already served (verified: HTTP 200, `application/json`, valid P38
> contract) at the landing container; once the tunnel is up it is live at
> `https://rubymik.com/version.json`, which is now RubyMIK's built-in default update URL.

## 2. SMTP2GO sender-domain auth — ✅ DONE (verified live in Cloudflare)

Confirmed via live DoH query (Cloudflare 1.1.1.1) on 2026-07-22 — the records are in
Cloudflare and SMTP2GO reports the domain verified (its mail passes SPF/DKIM):

| Record | Live value | State |
|--------|-----------|-------|
| TXT `rubymik.com` | `v=spf1 include:spf.smtp2go.com ~all` | ✅ present |
| TXT `_dmarc.rubymik.com` | `v=DMARC1; p=none; rua=mailto:ray@rubynet.co.za` | ✅ present |
| CNAME `link.rubymik.com` | `track.smtp2go.net` | ✅ present (SMTP2GO CNAME set wired) |
| DKIM | signed under SMTP2GO's return-path (`em####`) subdomain, not the apex `s1/s2._domainkey` | ✅ verified in SMTP2GO |

(The apex `s1/s2._domainkey` selectors are intentionally NXDOMAIN — SMTP2GO signs with a
selector under the `em####.rubymik.com` return-path domain it manages, so there's nothing
to add at the root.) Nothing pending here. When wiring app notifications, set the sender to
`noreply@rubymik.com` (Settings → Notifications; from-address is configurable, no hardcoded
sender).

## 3. Demo device — ✅ DONE (synthetic REST responder; qemu CHR was incompatible)

Attempted the qemu CHR (`evilfreelancer/docker-routeros`) under TCG per your call — it
**cannot** run on this demo's blast-radius network. Two hard blockers, independent of the
(known) TCG-is-slow issue:
1. Its entrypoint (`generate-dhcpd-conf.py`) **requires a default route** on the
   container's network → on `demonet` (`internal: true`, no route by design) it crashes
   with `ValueError: no default route` and crash-loops.
2. It needs **`/dev/net/tun`** (absent here) and `/dev/kvm` (absent → slow TCG).

I would **not** relax `internal: true` to satisfy it — the internal network *is* the blast
radius (a non-negotiable standing rule), so security wins. The `chr` service is left in the
compose but **profile-gated so it never starts**, with the incompatibility documented
inline.

**Current demo state (shipped):** the demo manages **one LIVE synthetic device** — a
**RouterOS-REST responder** (`server/src/devtools/demo-router.ts`, compose service
`router`) that runs on demonet and answers the `/rest/*` API RubyMIK polls with coherent
fabricated `zzz-*` data. It needs no default route / KVM / tun, so it runs where the qemu
CHR can't. The demo device (`zzz-demo-gw`, host `router:8080`, http) polls **`up`** and the
dashboard/traffic/topology/detail pages all populate (model RB5009UG+S+IN, 7 interfaces,
health, CPU/mem graphs, 3 discovered neighbors). Still **manages ZERO real devices** — every
byte is fabricated. Proven: banner ✓, viewer login ✓, isolation (`internal: true`) ✓,
nightly reset ✓, zero shared volumes ✓, live synthetic device ✓. Nothing pending here.

## 4. Demo admin credential

`scripts/reset-demo.sh` reads the demo's **admin** password from
`/opt/rubymik-demo/.admin-pass` (root-only, NOT in git, NOT published) — set it once:
`openssl rand -base64 18 > /opt/rubymik-demo/.admin-pass`. The **published** login is the
VIEWER `demo@rubymik.com` (password `rubymik-demo`, override via
`RUBYMIK_DEMO_VIEWER_PASS`). No admin account has a guessable credential.
