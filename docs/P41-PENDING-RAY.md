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

## 2. SMTP2GO — verify rubymik.com as a sender domain (SPF/DKIM)

So `noreply@rubymik.com` becomes the product sender. In the **SMTP2GO dashboard →
Sending → Sender Domains → Add `rubymik.com`**, SMTP2GO generates account-specific
CNAME tokens (I can't produce the literal values — they come from your account). You'll
get, to add in **Cloudflare DNS** (DNS-only / grey-cloud for the mail CNAMEs):

| Type | Host (typical) | Value | Purpose |
|------|----------------|-------|---------|
| CNAME | `em####.rubymik.com` | `return.smtp2go.net` | Return-Path / bounce (SPF alignment) |
| CNAME | `s1._domainkey.rubymik.com` | `dkim.smtp2go.net` (token) | DKIM key 1 |
| CNAME | `s2._domainkey.rubymik.com` | `dkim.smtp2go.net` (token) | DKIM key 2 |
| CNAME | `link.rubymik.com` | `track.smtp2go.net` | (optional) click tracking |

Plus these fixed records (safe to add now):

| Type | Host | Value |
|------|------|-------|
| TXT | `rubymik.com` | `v=spf1 include:spf.smtp2go.com ~all` |
| TXT | `_dmarc.rubymik.com` | `v=DMARC1; p=none; rua=mailto:ray@rubynet.co.za` |

Verify in SMTP2GO once the CNAMEs propagate, then set the app's SMTP sender to
`noreply@rubymik.com` (Settings → Notifications; the from-address is configurable, no
hardcoded sender).

## 3. Demo device — the qemu CHR is INCOMPATIBLE with the internal net (deferred)

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

**Current demo state (shipped):** the demo app runs and manages **one synthetic, offline
device** (`zzz-demo-chr`, host `10.99.0.1` — unreachable, shows `status=down`). That
honours "manages ZERO real devices" and the dashboard/login/config UI all demonstrate
fine. Proven: banner ✓, viewer login ✓, isolation (`internal: true`) ✓, nightly reset ✓,
zero shared volumes ✓.

**To show a LIVE device with synthetic data (follow-up):** the only design compatible with
`internal: true` is a **synthetic RouterOS-REST responder** container **on demonet** (it
needs no default route, no KVM, no tun — just an HTTP server answering the REST endpoints
RubyMIK polls). That's a small dedicated build (not the qemu CHR). Say the word and I'll
add it as a P41 follow-up; until then the offline synthetic device is the safe default.

## 4. Demo admin credential

`scripts/reset-demo.sh` reads the demo's **admin** password from
`/opt/rubymik-demo/.admin-pass` (root-only, NOT in git, NOT published) — set it once:
`openssl rand -base64 18 > /opt/rubymik-demo/.admin-pass`. The **published** login is the
VIEWER `demo@rubymik.com` (password `rubymik-demo`, override via
`RUBYMIK_DEMO_VIEWER_PASS`). No admin account has a guessable credential.
