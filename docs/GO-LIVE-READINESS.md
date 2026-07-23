# RubyMIK — Go-Live Readiness

**Version:** 0.9.1 · **Date:** 2026-07-22 · **Phase:** P39 (go-live gate) ·
**Repo:** PRIVATE (unchanged) · **Suite:** 268/268 green · **Deps:** 0 vulnerabilities

This is the honest readiness assessment that stands between "works on the bench" and
"a paying MSP installs it." Every item is **GREEN** (ready), **AMBER** (works, with a
caveat or an on-site step), or **RED** (not ready). Nothing here is a workaround for a
RED — a RED stays RED until it's genuinely fixed.

**Overall: GREEN to ship to a first, hand-held pilot MSP** once Ray executes the
day-of-release checklist (§4). With real PPPoE now proven end-to-end (§1a), the
PENDING-RAY business decisions are the only things between here and a wider launch.

---

## 1. Technical debts

| # | Item | Status | Evidence / cause |
|---|---|---|---|
| 1a | **Real PPPoE end-to-end** via a RubyMIK-created client | 🟢 **GREEN** | **Proven end-to-end on real hardware (2026-07-22)** via a physical **ether3↔ether4 loopback** on the bench hEX (RouterOS 7.23.2; mgmt 172.16.111.117 on ether1 — untouched throughout). Server side configured directly on the router (`/ppp secret p24test`, a small `/ip pool` + profile with local `10.99.39.1`/remote-from-pool, `/interface pppoe-server` `p39test` on ether4). Then **through RubyMIK** a `pppoe-client` was created on ether3 (audit `pppoe.create applied`; snapshot pre/post bracket) and enabled (`pppoe.enable applied`; pre/post bracket) — it went **`connecting → running` and negotiated an address: local `10.99.39.100`** from the pool (server active session `p24test → 10.99.39.100`, MTU 1492). The RubyMIK PPPoE panel shows the client `over ether3 · running · RUBYMIK · local addr 10.99.39.100` (screenshot on file). Torn down client (via RubyMIK) + server (direct); **bench export verified back to pre-state, 8/8 checks**. The former AMBER (completion to a *negotiated address*) is **closed** — it was always a single-box lab-cable limitation, never a RubyMIK defect. |
| 1b | **Update-check live** against a real static `version.json` | 🟢 **GREEN** | The 0.9.1 container, pointed at a stand-in static `version.json` (served over HTTP, advertising 0.9.2), fetched it and showed the banner **and** the Account → Software-updates card live (`updateAvailable:true`, `latest:0.9.2`). Nothing but the GET is sent. Production URL swap is **config-only** (`RUBYMIK_UPDATE_URL`), PENDING-RAY domain. |
| 1c | **P32 leftovers** (inline-edit tunnels/PPP, `.ovpn` export, on-router cert gen) | 🟢 **GREEN** | Already closed in `1431e14`: `EditTunnelForm` (inline edit) and `OvpnExport` ship in `VpnManager.tsx`; on-router certificate generate/delete shipped and was verified live in P32. No open P32 gaps. |

## 2. Security hardening (self-audit + fixes)

| # | Item | Status | Evidence |
|---|---|---|---|
| 2a | **No default credential survives onboarding** | 🟢 **GREEN** | RubyMIK ships with **no seeded admin** — the first screen forces the operator to create one (username ≥3, password ≥8). Proven live: before setup every protected API is 401; a guessed `admin/admin` login → 401; `/setup` creates the chosen account; once set up, `/setup` → 409. Better than "force a change" — there is no default to change. |
| 2b | **Login rate-limit + lockout + audit** | 🟢 **GREEN** | New `LoginLimiter`: 5 failures per (IP, account) in 15 min → locked 15 min. Proven live: 5 bad logins → the 6th (even with the correct password) returns **429 + Retry-After: 900**, and the Audit page shows `auth.login.locked` with the real client IP. Unit + integration tests cover lock/unlock/isolation. |
| 2c | **Session cookie flags** | 🟢 **GREEN** | Cookies are `HttpOnly; SameSite=Lax` always, and **`Secure` is added automatically when the request arrived over HTTPS** (X-Forwarded-Proto=https behind a trusted proxy). Proven both ways in tests. |
| 2d | **HTTPS story / reverse proxy / X-Forwarded** | 🟢 **GREEN** | `RUBYMIK_TRUST_PROXY` enables Express `trust proxy` so `req.secure`/`req.ip` honour X-Forwarded-*. Docs gain a reverse-proxy section (Caddy/NPM/Traefik) and a **"do not expose :8080 raw to the internet"** warning — see `README-DEPLOY.md` §HTTPS. |
| 2e | **Dependency audit** | 🟢 **GREEN** | `npm audit` (server + web, dev + prod): **0 vulnerabilities**. All deps are pure-JS (no native modules). |
| 2f | **Header hardening / CSP** | 🟢 **GREEN** | A strict CSP on every response: `default-src 'self'`, `script-src 'self' '<sha256 of the one inline theme script>'` (**no `unsafe-inline`** for scripts — the inline script is hashed from the served file at boot), `object-src 'none'`, `frame-ancestors 'self'`, plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`. Verified live via response headers. |
| 2g | **API 401/403 matrix** | 🟢 **GREEN** | Re-run as tests: unauthenticated → 401 sweep; role matrix (reads all roles, writes editor+, user-mgmt admin-only, viewer 403) in `auth.roles.test.mjs`; lockout 429 in `security.test.mjs`. |
| 2h | **Secrets sweep (working tree + history)** | 🟢 **GREEN** | Git history across all refs: the only credential-ish file ever added is `.env.example` (a template). No `.env`, `secret.key`, `.pem`, private keys, or 64-hex key literals ever committed; the SMTP session password appears **0** times. Keys are never baked into the image (inspect + FS grep clean). |

## 3. Docs for a stranger

| # | Item | Status | Evidence |
|---|---|---|---|
| 3a | **README** (what it is, honest feature list, screenshots, not-affiliated footer) | 🟢 **GREEN** | Intro corrected (monitoring **and** configuring — the "coming soon" was stale); honest maturity note; three real screenshots (dashboard, topology, device view) in `docs/img/`; a **Trademarks & affiliation** footer stating RubyMIK is **not affiliated with SIA Mikrotīkls**. |
| 3b | **INSTALL / UPDATE / BACKUP-RESTORE cold-follow** | 🟢 **GREEN** | Executed `README-DEPLOY.md` verbatim in a clean project: files copied, both keys generated with the documented `openssl` lines, `compose up` → healthy, first-run setup 201 / login 200, a self-backup ran + **restore-drill passed (7/7 checks)**, update recreate ran. **0 doc bugs.** (Deviations were test-host isolation only — ports/project — a fresh MSP host needs none.) |
| 3c | **FIRST-ROUTER runbook** | 🟢 **GREEN** | `docs/FIRST-ROUTER.md`: read-only credential → add monitor-only → verify polling → write credential → manageable; a table of what the guards refuse and why; where snapshots/backups/audit live. |

---

## 4. PENDING-RAY ledger (business/ops decisions — not code)

These are Ray's to decide/action; none is a code blocker. Verbatim:

1. **License decision** — the OSS licence for public release (repo currently MIT in
   `LICENSE`, but the *public* release is a separate explicit act). Precedes any
   public artifact.
2. **`rubymik.com` / `version.json` home + sender domain** — the domain that hosts
   the update `version.json` (built-in default is `get.rubymik.com`) and the email
   sender domain for notifications. Swap is config-only (`RUBYMIK_UPDATE_URL`).
3. **SFTP / off-host backup wiring** — the P36 off-host copy is `path`-only in v1
   (a mounted volume). SFTP/rclone destinations are stubbed (`PENDING-RAY`).
4. **`RUBYMIK_BACKUP_KEY` stored off-machine** — confirm the production backup key
   is generated and stored **off** the RubyMIK host (a backup + its key together are
   plaintext-equivalent). Ops confirmation, not code.
5. **Telegram / WhatsApp channel activation** — the channels exist (P31) but need
   real tokens/allowlists to go live.
6. **P35 live fleet upgrades** — fleet-wide RouterOS upgrade orchestration stays
   **gated by design** (attended-only; the destructive trigger is left to an
   operator). **Not a go-live blocker** — a deliberate safety posture.
7. **Public registry flip** — flipping the GHCR package + `scripts/release.sh`
   `PUBLIC=false→true` to publish images publicly. One gated line; do not flip until
   the licence decision (item 1) is made.

---

## 5. "Day of release" — the ordered checklist Ray runs manually

Execute top to bottom. Each step gates the next.

1. **Licence** — finalise and commit the public licence (item 4.1). Nothing public
   happens before this.
2. **Domain** — stand up `get.rubymik.com/version.json` (and the sender domain);
   point `RUBYMIK_UPDATE_URL` there (or accept the built-in default). Verify a test
   instance shows the banner against the real URL.
3. **Backups (P44)** — enable backups in **one click** from the Backup page (the app
   generates + stores the key in `/data`); confirm a self-backup + restore-drill passes.
   Optionally **Download recovery key** and turn on strict off-server mode. The
   `RUBYMIK_BACKUP_KEY` env is now **optional/advanced** (env wins if present).
   > **v1.1.0 release gate:** v1.1.0 ships a database migration, and the P38 boot guard
   > takes a pre-migration backup — which requires backups to be enabled. v1.1.0 therefore
   > **must ship with P44** (one-click enable). A migration release must never require
   > compose surgery to turn on the backup the migration depends on. Do not tag v1.1.0
   > until P44 + P43.5 land.
4. **Registry flip** — set the GHCR package public, set `PUBLIC=true` in
   `scripts/release.sh`, and `scripts/release.sh --push` a signed `v0.9.1` (or
   `v1.0.0`) image. Verify a clean `docker compose pull && up -d` from a machine with
   no special access.
5. **Repo public** — flip the GitHub repo to public (README, docs, LICENSE ready).
6. **PPPoE GREEN (optional, recommended)** — do the 5-minute on-site loopback-cable
   PPPoE test (item 1a) to close the last AMBER before announcing.
7. **Announce** — the MikroTik forum post / launch note, linking the repo and the
   not-affiliated disclaimer.

---

## 6. Known gaps (backlog — not go-live blockers)

- **PRINCIPLE (established P45, enforced going forward): any feature that needs a
  host-level privilege must PRE-CHECK the capability and INSTRUCT the operator BEFORE
  offering the action — never fail raw.** A clickable control that produces a kernel
  error (e.g. `RTNETLINK ... operation not permitted`) is a bug, not an error message.
  The pattern: (1) detect the capability at load without a side effect that itself fails
  (read `/proc/self/status` for caps; only live-probe when the cap is present); (2) if
  it's missing, replace the action with a setup card that makes the one irreducible
  server-side step copy-paste trivial for *every* deployment method (a complete,
  ready-to-paste Portainer stack; the CLI override; a plain-language "what/why"); (3) a
  belt-and-suspenders server guard returns the honest reason, not the raw error, if the
  action is somehow invoked anyway; (4) name the boundary truthfully — it's Docker's
  security model, not ours. First applied to Remote Access (WireGuard hub / NET_ADMIN);
  applies to anything similar (raw sockets, privileged ports, kernel modules).
- **DNS filtering end-to-end (P43) — unproven as one chain.** The full path *client →
  router `:53` redirect → filtering resolver → blocked answer* has never run start-to-finish
  on real hardware. Each layer is proven independently — the redirect/enforcement rule-set is
  sim-diffed and the router objects were applied + verified on the bench (P43.3); Blocky's
  category/custom blocking and the reload-verify are proven live (P43.1) — but the bench had no
  LAN client and no bench-reachable resolver to join them. Same class as the P24 PPPoE-server
  gap. **Verify on the first real filtered deployment** (pilot-zero or a customer site);
  it comes off this list the day filtering runs for real end-to-end.
  - Also unmeasured there: the **fail-open leakage rate** (how often RouterOS's `/ip/dns`
    server-selection reaches the fallback while the resolver is healthy). The UI states the
    behaviour honestly without a number; measure it on that first real deployment.
- **Bench health note (for future live sessions).** The write-test bench's www service
  intermittently returns an **empty `/export`**, which makes the P21 fail-closed snapshot
  correctly refuse a write ("no snapshot, no write"). This is the safety working, not a bug —
  future bench sessions should **expect occasional fail-closed refusals and retry**, not work
  around the snapshot gate.

- ~~**Admin self-recovery / password reset.**~~ **CLOSED in P40.** RubyMIK now has
  (1) a **"Forgot password?"** flow that emails a single-use, 30-minute, enumeration-
  safe reset link when SMTP is configured, and (2) a supported, documented CLI reset
  — `docker exec -it rubymik node scripts/reset-admin.mjs` — baked into the image,
  using the app's own argon2id, clearing sessions (and optionally 2FA) and auditing
  the action. Interim mitigation (a second admin) still recommended. See
  README-DEPLOY.md §4c.

## Appendix — process note (transparency)

During the doc cold-follow, a first attempt ran `docker compose` from a copy of
`docker-compose.yml` that carries `name: rubymik`; without a project override this
shared the **local dev instance's** volumes, and the trailing `down -v` deleted them
— wiping the throwaway dev RubyMIK on `:8080` (2 lab devices, no customer data). It
was **restored fresh** (admin re-created, bench re-added monitor-only) and the
cold-follow was **re-run correctly** with `-p` project isolation (the clean 0-doc-bug
result above). No customer system, no router, and no production data were involved;
The monitor-only device was never written to. Lesson recorded: a second instance from a copy of the
compose must use its own project (`-p`) — irrelevant to a real single-instance MSP.
