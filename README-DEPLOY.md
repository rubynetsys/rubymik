# Deploying RubyMIK

RubyMIK ships as a single Docker image. A typical MSP install is:

```bash
docker compose up -d
```

…and an update is:

```bash
docker compose pull && docker compose up -d
```

Everything below explains the pieces around those two commands: the keys you must
set, every environment variable, and the exact update and rollback procedures.

> **Registry access.** The image lives in a **private** registry
> (`ghcr.io/rubynetsys/rubymik`). Log in first:
> `echo "$GH_TOKEN" | docker login ghcr.io -u <user> --password-stdin`
> (a GitHub token with `read:packages`). RubyMIK is not public yet.

---

## 1. Requirements

- A Linux host with **Docker Engine 24+** and the **compose v2** plugin.
- One TCP port for the dashboard (default **8080**) and one for the WebFig proxy
  (default **8081**). Both must be reachable by the browsers that will use RubyMIK.
- Network reachability from the host to your MikroTik devices (LAN, or via the
  built-in WireGuard remote-access hub).
- ~250 MB disk for the image, plus room in the `/data` volume for the SQLite DB,
  config backups, and snapshots (grows with your fleet; a few hundred MB is ample
  for dozens of devices).

The image is `node:22-alpine` based and runs as a **non-root** user. It is
published **multi-arch** (`linux/amd64` and `linux/arm64`), so it runs on x86
servers and ARM boards alike.

> **Why Node 22, not 20/slim?** RubyMIK uses Node's built-in SQLite
> (`node:sqlite`), which requires **Node ≥ 22.13**. Node 22 is also the last line
> published for `linux/arm/v7`. Do not repin the base image below 22.

---

## 2. First install

1. Create a working directory and drop in `docker-compose.yml` and a `.env`:

   ```bash
   mkdir -p /opt/rubymik && cd /opt/rubymik
   # copy docker-compose.yml here, then:
   cp .env.example .env      # or create .env from the variables in §4
   ```

2. **Generate the two keys** and put them in `.env` (see §3 — do this before first
   boot):

   ```bash
   echo "RUBYMIK_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
   echo "RUBYMIK_BACKUP_KEY=$(openssl rand -hex 32)"     >> .env
   ```

3. Start it:

   ```bash
   docker compose up -d
   docker compose logs -f      # watch it come up; Ctrl-C to stop watching
   ```

4. Open `http://<host>:8080`. The first screen creates your admin account. Add a
   device from **Add device** and you're monitoring.

Health: `curl -s http://<host>:8080/api/health` → `{"ok":true,"version":"…","schema":…}`.
Docker also runs this as the container `HEALTHCHECK` (visible in `docker ps`).

---

## 3. Keys — read this before first boot

RubyMIK holds two independent AES-256 keys. **Neither is ever baked into the image**
(verify: `docker run --rm --entrypoint sh <image> -c 'find / -name secret.key -o -name .env'`
finds nothing). They are read from the environment only.

| Key | What it protects | If you lose it |
|-----|------------------|----------------|
| **`RUBYMIK_ENCRYPTION_KEY`** | Device/VPN/notification credentials stored in the DB (field encryption). | You must re-enter every device credential. |
| **`RUBYMIK_BACKUP_KEY`** | The whole-DB self-backups **and** the automatic pre-upgrade backup. | Existing backups become unreadable. |

Rules:

- **Set both before first boot.** If `RUBYMIK_ENCRYPTION_KEY` is unset, RubyMIK
  generates one at `/data/secret.key` (persisted in the volume) — fine for a quick
  trial, but you should manage it yourself in production so it survives a volume
  loss and lives in your secret store.
- **`RUBYMIK_BACKUP_KEY` must differ from `RUBYMIK_ENCRYPTION_KEY`** (RubyMIK
  refuses to start if they match — a backup encrypted with the field key protects
  nothing new).
- **Store the backup key OFF this host**, apart from the backups themselves. A
  backup plus its key together are plaintext-equivalent.
- Keys reach the container via the environment / your `.env`. The `.env` is
  git-ignored and excluded from the image build context. Never commit it.

> **The backup key gates upgrades.** RubyMIK will not apply a schema migration
> without first taking an encrypted backup (see §5). If `RUBYMIK_BACKUP_KEY` is
> unset when a new image needs to migrate, the app **refuses to start** with a
> clear message rather than migrate un-backed-up data. Keep the backup key set.

---

## 4. Environment variables

All have working defaults except the two keys. Set them in `.env` (compose reads it
automatically) or in the `environment:` block.

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUBYMIK_IMAGE` | `ghcr.io/rubynetsys/rubymik:latest` | The image to run. Pin a tag (e.g. `…:0.9.1`) to control upgrades explicitly. |
| `RUBYMIK_PORT` | `8080` | Host port for the dashboard/API. |
| `RUBYMIK_WEBFIG_PORT` | `8081` | Host port for the WebFig reverse proxy (router admin UIs). `0` disables it. |
| `RUBYMIK_ENCRYPTION_KEY` | *(generated to `/data/secret.key`)* | 64 hex chars. Field-encryption key — see §3. |
| `RUBYMIK_BACKUP_KEY` | *(unset ⇒ self-backups disabled)* | 64 hex chars, **must differ** from the encryption key. DB self-backup + pre-upgrade backup key — see §3. |
| `RUBYMIK_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `RUBYMIK_POLL_INTERVAL` | `30` | Seconds between health polls (5–3600). `0` = monitoring paused (serve stored state only). |
| `RUBYMIK_POLL_CONCURRENCY` | `4` | Max devices polled in parallel (1–16). |
| `RUBYMIK_BACKUP_INTERVAL` | `86400` | Seconds between per-device config-backup runs. |
| `RUBYMIK_BACKUP_KEEP` | `10` | Config backups kept per device. |
| `RUBYMIK_SNAPSHOT_INTERVAL` | `86400` | Seconds between scheduled config snapshots. |
| `RUBYMIK_SELFBACKUP_INTERVAL` | `21600` | Seconds between DB self-backups (6h). |
| `RUBYMIK_SELFBACKUP_KEEP` | `28` | DB self-backups kept locally (7 days @ 6h). |
| `RUBYMIK_UPDATE_URL` | built-in | Override the daily update-check URL (or point at a mirror). Turn the check off in-app. |
| `RUBYMIK_TRUST_PROXY` | `false` | Enable when behind a TLS-terminating reverse proxy so `X-Forwarded-Proto`/`For` are honoured (`Secure` cookie, real client IP for rate-limiting). `true` \| a hop count \| a subnet/keyword (see §4b). |
| `RUBYMIK_PUBLIC_URL` | *(the request's own host)* | The externally-reachable base URL (e.g. `https://rubymik.example.com`) used to build **password-reset links** in emails. Set it when the URL users hit differs from what the container sees. |
| `RUBYMIK_DEFAULT_THEME` | `ruby-light` | Instance default theme (a user's own choice overrides it). |
| `RUBYMIK_DEFAULT_ACCENT` | *(unset)* | Instance default accent colour. |

The `/data` volume holds the SQLite DB, generated key file (if any), config
backups, snapshots, and DB self-backups. **`/data` is the only volume you must
persist and back up.** (`/offhost` is an optional second mount used as an off-host
copy target for DB self-backups.)

---

## 4b. HTTPS & putting RubyMIK behind a reverse proxy

> ⚠️ **Do not expose RubyMIK's `:8080` (or `:8081`) directly to the internet.** It
> speaks plain HTTP and is meant for a trusted LAN or a private overlay. If RubyMIK
> must be reachable remotely, put it behind a TLS-terminating reverse proxy (or reach
> it over a VPN / the built-in WireGuard). Never port-forward `:8080` to the world.

When a proxy terminates TLS in front of RubyMIK, set **`RUBYMIK_TRUST_PROXY`** so the
app honours `X-Forwarded-Proto`/`X-Forwarded-For`. Two things depend on it:

- the session cookie gains the **`Secure`** flag (RubyMIK sees the request as HTTPS);
- the **login rate-limiter and audit** log the *real* client IP, not the proxy's.

Set it to `true` when RubyMIK sits behind exactly one proxy you control. (`true`
trusts the immediate upstream; a number trusts that many hops; a subnet/keyword like
`10.0.0.0/8` is passed to Express verbatim.) Bind the container's port to `127.0.0.1`
so only the proxy can reach it.

**Caddy** (automatic HTTPS — the shortest path):

```
rubymik.example.com {
    reverse_proxy 127.0.0.1:8080
}
```
```yaml
# docker-compose: bind to localhost so only Caddy reaches it
services:
  rubymik:
    ports: ["127.0.0.1:8080:8080"]
    environment:
      RUBYMIK_TRUST_PROXY: "true"
```

**Nginx Proxy Manager (NPM)** — add a Proxy Host → forward to `rubymik:8080`, enable
**Websockets**, request a Let's Encrypt cert, and set `RUBYMIK_TRUST_PROXY=true` on
the container. (WebFig, if used, needs its own proxy host to `:8081`.)

**Traefik** (labels):

```yaml
services:
  rubymik:
    environment:
      RUBYMIK_TRUST_PROXY: "true"
    labels:
      - traefik.enable=true
      - traefik.http.routers.rubymik.rule=Host(`rubymik.example.com`)
      - traefik.http.routers.rubymik.tls.certresolver=le
      - traefik.http.services.rubymik.loadbalancer.server.port=8080
```

After wiring it up, confirm HTTPS end-to-end: log in over `https://…` and check the
session cookie carries `Secure` (browser dev-tools → Application → Cookies).

---

## 4c. Password reset & admin recovery

RubyMIK signs users in by **email**. There are two recovery paths.

**Forgot password (email).** If SMTP is configured (Settings → Notifications), the
sign-in page's **"Forgot password?"** link emails a single-use, 30-minute reset link.
Set `RUBYMIK_PUBLIC_URL` so the link points at the address your users actually use.
The response is deliberately identical whether or not the email exists (no account
enumeration), and requests are rate-limited.

**Locked out with no email (self-hosted recovery).** If SMTP isn't set up — or the
*only* admin is locked out — reset an account from the server's shell:

```bash
docker exec -it rubymik node scripts/reset-admin.mjs
```

It lists the accounts, lets you pick one, sets a new password using RubyMIK's own
argon2id hashing, optionally clears that account's 2FA, invalidates its sessions,
audits the action, and prints the new password **once**. (A brute-force lockout is
in-memory; restart the container to clear it.)

> **Tip:** create a **second admin** so a lockout of one is always recoverable from
> the other without touching a shell.

---

## 4d. Running more than one instance on one host

The shipped `docker-compose.yml` intentionally has **no hard-coded project `name:`**,
so Compose derives the project from the directory — a copy in a *different* directory
gets its **own** isolated volumes (a second instance can never silently attach to, or
`docker compose down -v` wipe, another install's data). It keeps a fixed
`container_name: rubymik` so a naive second instance fails *loudly* on the name clash
rather than sharing state. To genuinely run two on one host, give the second its own
directory, and override `container_name`, `RUBYMIK_PORT`, and `RUBYMIK_WEBFIG_PORT`.

---

## 5. Updating

RubyMIK never updates itself. When the in-app banner (or **Account → Software
updates**) says a newer version exists:

```bash
cd /opt/rubymik
docker compose pull          # fetch the new image
docker compose up -d         # recreate the container on the same /data volume
docker compose logs -f       # watch the upgrade
```

On the first boot of a newer image, RubyMIK:

1. Detects the schema and/or app-version change.
2. **Takes an encrypted pre-upgrade backup** into `/data/self-backups/` (this is
   fail-closed — if the backup can't be taken, it refuses to migrate).
3. Applies any pending migrations, each in its own transaction.
4. Starts serving. You'll see log lines like:

   ```
   Boot upgrade-guard: pre-upgrade backup written (/data/self-backups/…​.bkp).
   Applied database migration 20/20
   RubyMIK listening on http://0.0.0.0:8080
   ```

Then confirm: `curl -s http://<host>:8080/api/health` shows the new `version` and
`schema`, and you can log in.

> **Pinning.** To control exactly when you move, set `RUBYMIK_IMAGE` to a specific
> tag (`ghcr.io/rubynetsys/rubymik:0.9.1`) instead of `latest`, and bump it when you
> choose to update. Check `CHANGELOG.md` for the schema version and any breaking
> notes before a major move.

There are **no down-migrations.** Going back a schema version is a restore, not a
migration — see §6.

---

## 6. Rolling back

If an update misbehaves, roll back to the previous image **and** the pre-upgrade
backup that the update took automatically:

1. Stop the container:

   ```bash
   docker compose down
   ```

2. Restore the pre-upgrade backup into the `/data` volume. It's the newest `.bkp`
   in `/data/self-backups/` (the one written just before the migration). Decrypt it
   with your `RUBYMIK_BACKUP_KEY` and write it back as `/data/rubymik.db`. From the
   RubyMIK app you can also do this from **Backup → Restore drill / restore**; from
   the shell, the backup is `magic(6) ‖ iv(12) ‖ gcm-tag(16) ‖ ciphertext`
   (AES-256-GCM) — see the restore procedure shipped with any snapshot's
   "Full restore (manual)" download.

3. Pin the previous image tag and start it:

   ```bash
   # in .env (or compose):
   RUBYMIK_IMAGE=ghcr.io/rubynetsys/rubymik:0.9.0
   docker compose up -d
   ```

4. Confirm health and login on the old version.

Because the pre-upgrade backup was taken at the **old** schema, the old image opens
it cleanly. (Restoring a *newer*-schema DB under an *older* image is not supported —
always pair the rollback image with a backup from that schema.)

---

## 7. Backups (independent of upgrades)

Beyond the automatic pre-upgrade backup, RubyMIK runs scheduled encrypted
DB self-backups every 6h (tunable) and can copy them off-host. Configure and
monitor them on the **Backup** page. The banner turns red if no successful backup
has happened within the safety window. Keep `RUBYMIK_BACKUP_KEY` set and stored
off-host — it is the only thing that can read a backup.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Container exits immediately, log says *"Refusing to migrate … RUBYMIK_BACKUP_KEY is not set"* | A schema upgrade needs a pre-upgrade backup. Set `RUBYMIK_BACKUP_KEY` and `up -d` again. |
| *"RUBYMIK_BACKUP_KEY must differ from RUBYMIK_ENCRYPTION_KEY"* | The two keys are identical. Generate a distinct backup key. |
| *"Database migration N failed and was rolled back — refusing to start"* | A migration hit an error and was rolled back cleanly. Restore the pre-upgrade backup and pin the previous tag (§6); report the log. |
| Health check failing in `docker ps` | `docker compose logs` — usually a bad env value (the app validates and reports it) or the port already in use. |
| Update banner never appears | The daily check is off (Account → Software updates), or the host can't reach the update URL. The check failing is silent and harmless; nothing about your instance is sent. |

---

## 9. Building from source (optional)

You don't need source to run RubyMIK, but to build your own image:

```bash
scripts/release.sh --load        # build + load a local single-arch image
scripts/release.sh               # verify the multi-arch build (no push)
scripts/release.sh --push        # build multi-arch + push to the private registry
```

The script runs the full test suite first, tags `vX.Y.Z` (+`latest`), and pushes
to the **private** registry. Publishing publicly is intentionally a one-line,
gated change — it is not done here.
