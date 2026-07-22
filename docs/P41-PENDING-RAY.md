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

**b. Demo (demo.rubymik.com):** same, public hostname `demo.rubymik.com` →
`http://rubymik-demo:8080`; token into `/opt/rubymik-demo/.env` as
`RUBYMIK_DEMO_TUNNEL_TOKEN=…`; then `--profile tunnel up -d`. **Also add a Cloudflare
rate-limit rule** on demo.rubymik.com (e.g. 60 req/min/IP) — the phase asks for
proxy-level rate limiting and Cloudflare is the proxy.

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

## 3. Demo CHR — hosting decision (no KVM on this host)

165.73.244.111 has **no `/dev/kvm`** (virt flags = 0), so a RouterOS CHR runs only under
qemu **TCG (software emulation)** — slow and CPU-heavy, risky on a box shared with
RubyFinance et al. The demo compose (`docker-compose.demo.yml`) + nightly reset
(`scripts/reset-demo.sh` + the systemd timer) are ready; pick one:
- **(A)** run the CHR here under TCG with the resource cap already set (`cpus 1.5, mem
  640M`) — accept slow CHR boot (~minutes) — `docker compose --profile chr up -d`;
- **(B)** host the CHR on a KVM-capable box and point the demo at it;
- **(C)** enable nested virt on this VPS if the provider allows, then uncomment
  `/dev/kvm` in the compose.
Until then the demo app runs (banner + viewer login work); the managed CHR shows as
down. `demonet` is `internal: true` so the CHR/demo have no LAN/other-network route —
the isolated network is the blast radius (verify once the CHR boots: from CHR,
`8.8.8.8` and other 172.x subnets are unreachable; only the demo container answers).

## 4. Demo admin credential

`scripts/reset-demo.sh` reads the demo's **admin** password from
`/opt/rubymik-demo/.admin-pass` (root-only, NOT in git, NOT published) — set it once:
`openssl rand -base64 18 > /opt/rubymik-demo/.admin-pass`. The **published** login is the
VIEWER `demo@rubymik.com` (password `rubymik-demo`, override via
`RUBYMIK_DEMO_VIEWER_PASS`). No admin account has a guessable credential.
