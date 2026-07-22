# RubyMIK — Go-Live Readiness

**Version:** 0.9.1 · **Date:** 2026-07-22 · **Phase:** P39 (go-live gate) ·
**Repo:** PRIVATE (unchanged) · **Suite:** 252/252 green · **Deps:** 0 vulnerabilities

This is the honest readiness assessment that stands between "works on the bench" and
"a paying MSP installs it." Every item is **GREEN** (ready), **AMBER** (works, with a
caveat or an on-site step), or **RED** (not ready). Nothing here is a workaround for a
RED — a RED stays RED until it's genuinely fixed.

**Overall: GREEN to ship to a first, hand-held pilot MSP** once Ray executes the
day-of-release checklist (§4). One AMBER (real PPPoE handshake — a 5-minute on-site
cable step) and the PENDING-RAY business decisions are the only things between here
and a wider launch.

---

## 1. Technical debts

| # | Item | Status | Evidence / cause |
|---|---|---|---|
| 1a | **Real PPPoE end-to-end** via a RubyMIK-created client | 🟡 **AMBER** | The **write-path is proven on real hardware**: on the bench hEX S (RouterOS 7.23.2) RubyMIK created a `pppoe-client` on an isolated bridge (audit `pppoe.create applied`), enabled it (`pppoe.enable applied`), and it entered a genuine PPP negotiation (status `connecting` — real PADI). Guards behaved (isolated bridge allowed; mgmt on ether1 untouched). **What is unproven:** completion to a *negotiated address*, because a single-box bench cannot present a real PPPoE peer — a server and client on one bridge don't exchange discovery frames, there are no looped spare ports, and the only other RouterOS (Home Lab) is monitor-only by rule. **Remedy for GREEN:** one physical loopback cable between two bench ports, or a second writable RouterOS / accel-ppp on a real segment — a ~5-minute on-site step for Ray. This is a lab limitation, **not a RubyMIK defect**. |
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
3. **Backup key** — generate the production `RUBYMIK_BACKUP_KEY`, store it off-host,
   and confirm a self-backup + restore-drill passes on the production box.
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
Home Lab was never written to. Lesson recorded: a second instance from a copy of the
compose must use its own project (`-p`) — irrelevant to a real single-instance MSP.
