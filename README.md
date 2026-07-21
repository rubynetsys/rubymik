# RubyMIK

**Modern, self-hosted monitoring for MikroTik RouterOS — think "The Dude", reimagined.**

RubyMIK is an open-source dashboard for monitoring (and soon, configuring) your MikroTik
devices. It runs anywhere Docker runs — a Linux server, a Raspberry Pi, a Mac — talks to
your routers directly over the LAN via the RouterOS REST API, and needs **no external
database, no cloud account, no tunnels**. Clone it, run it, add a router. Done.

> ⚠️ **Early days:** RubyMIK currently does device management, background health
> polling, and a multi-site fleet overview. Traffic graphs, deeper time-series and
> alerting are landing next.

**What you get today**

- **Fleet overview** — every device across every site on one screen: status
  (up / warning / down), CPU, memory, uptime, RouterOS version, with per-site
  roll-ups and filtering. Auto-refreshes.
- **Live topology map** — auto-discovered from MNDP/LLDP/CDP neighbor tables
  (`/ip/neighbor`), drawn with a clean force layout: managed devices show live
  health status and click through to their device view; discovered-but-unmanaged
  neighbors render distinct (dashed) with an "Add this device" shortcut.
  Site-filterable, pan/zoom, updates on the poll cadence.
- **Device deep view** — click any device: live interfaces with RX/TX rates,
  per-interface traffic graphs (1h/6h), DHCP leases, ARP, routes, wireless
  registrations, switch ports, health/temperature, recent log — the
  RouterOS-native depth generic SNMP tools can't cleanly show. Sections
  capability-detect per device and say "not applicable" honestly instead of
  faking panels.
- **Sites** — group devices by location or client (MSP-style). The data model is
  built for per-user site scoping later; today a single admin sees everything.
- **Background poller** — staggered, timeout-isolated REST polling on a
  configurable interval (default 30s). One dead router never stalls the fleet.
  Interface counters ride the same cycle (one packed row per device, pruned to
  6h) — no separate loop, no SQLite thrash.
- **Alerting** — device down, high CPU/memory/temperature, and interface-down
  rules evaluated on every poll cycle with debounce + hysteresis (N consecutive
  cycles to fire, N to resolve, with a dead band — no flapping, no spam). One
  active alert per condition, auto-resolve, 30-day history, site-scoped views,
  and a webhook notification channel (off by default; posts JSON on fire and
  resolve to whatever you run — ntfy, Gotify, Discord/Slack bridges, Home
  Assistant, n8n). Nothing phones home, ever.
- **DHCP reservations** *(first config-write feature)* — on a **manageable**
  device you can add / edit / remove static leases and pin a dynamic lease.
  Every write runs the safe-apply pipeline and is audited. Devices without a
  write credential stay monitor-only and show DHCP read-only.
- **Managed firewall** — preset-driven (Off / Basic / Standard) + guarded
  custom rules, with a **management-accept rule always emitted first** so a
  preset can't lock RubyMIK out, plus a dead-man that auto-reverts if the
  management path is lost after a change. Monitor-only devices show it read-only.
- **Config backup & restore** — scheduled fleet-wide config backups + one-click
  manual backup, stored compressed with a "what changed" **diff** between any two.
  Backups are read-safe (a read-only snapshot on monitor-only devices; a
  canonical export on manageable ones). **Restore** re-applies a backup through
  the audited dead-man pipeline, with a device-mismatch guard.
- **Monitoring is read-only by design** — the monitoring client only issues GET
  requests to RouterOS (rates are derived from byte counters precisely because
  the monitor commands are POST). A `group=read` user is all monitoring needs.
  Configuration is a **separate, explicit** capability (see below).

_Screenshots coming soon._

## 5-minute quickstart

Requirements: Docker with the compose plugin. That's it.

```bash
git clone https://github.com/rubynetsys/rubymik.git
cd rubymik
docker compose up -d
```

Open **http://localhost:8080** (or `http://raspberrypi.local:8080`, or your host's IP).

1. Create your admin account (first run only — nothing is hardcoded).
2. Add a device: router IP + a RouterOS username/password.
3. See your router's model, RouterOS version, uptime, CPU and memory.

All data (SQLite database + generated encryption key) lives in the `rubymik-data`
Docker volume and survives restarts and upgrades.

## What your router needs

- **RouterOS 7.1 or newer** with the REST API reachable — the `www` (HTTP) or
  `www-ssl` (HTTPS) service enabled in *IP → Services*. Self-signed certificates are
  fine; RubyMIK skips verification by default (it's your LAN).
- A user for RubyMIK. Monitoring only needs read access:
  ```
  /user add name=rubymik group=read password=<something-strong>
  ```
- RubyMIK must be on a network that can reach the router (LAN-direct by design;
  WireGuard/remote support is planned, not required).
- RouterOS 6.x (legacy API, port 8728) is stubbed but **not supported yet** — planned.

## Configuration

Everything has a working default — configuration is optional. See [.env.example](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUBYMIK_PORT` | `8080` | Web dashboard port |
| `RUBYMIK_DATA_DIR` | `/data` (Docker) / `./data` | SQLite DB + generated secrets |
| `RUBYMIK_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `RUBYMIK_ENCRYPTION_KEY` | auto-generated | 64-hex-char AES-256 key for credentials at rest |
| `RUBYMIK_POLL_INTERVAL` | `30` | Seconds between health poll cycles (5–3600) |
| `RUBYMIK_POLL_CONCURRENCY` | `4` | Max devices polled in parallel (1–16) |
| `RUBYMIK_BACKUP_INTERVAL` | `86400` | Seconds between scheduled config backups (60–2592000) |
| `RUBYMIK_BACKUP_KEEP` | `10` | Config backups retained per device (1–500) |

Device credentials are stored **AES-256-GCM encrypted** in SQLite — never plaintext.

## Health states

Simple, honest rules — no fabricated scores:

| State | Meaning |
| --- | --- |
| 🟢 Up | Last poll succeeded, metrics under thresholds |
| 🟡 Warning | Reachable, but CPU ≥ 85% or memory ≥ 90% |
| 🔴 Down | The most recent poll attempt failed (reason shown; last-known data kept) |
| ⚪ Pending | Added but not polled yet |

## How topology links are inferred (honestly)

The map draws **direct neighbor sightings only** — device A reported neighbor N
on interface X in its `/ip/neighbor` table. Bidirectional sightings (A sees B,
B sees A) collapse into one edge that keeps both ports. Neighbors are matched
to managed devices by interface MAC first, then by IP; never by identity alone
(too many routers are literally named "MikroTik"). RubyMIK does not guess
transitive links or invent topology: fewer, high-confidence links beat a
hairball. If a device's discovery settings are disabled or limited to an
interface list, the map says so — enabling discovery is a RouterOS config
change RubyMIK deliberately won't make for you (read-only by design).

## Configuration writes & the safe-apply framework

RubyMIK is read-only for monitoring and stays that way. Configuration is a
distinct, opt-in capability with a hard structural boundary:

- **Two clients, one boundary.** `server/src/routeros/rest.ts` is the
  monitoring client and contains exactly one HTTP verb — `GET`.
  `server/src/routeros/write.ts` is the *only* module that issues
  `PUT`/`PATCH`/`DELETE` to a device, and nothing in the poller or any
  monitoring route can reach it. Monitoring physically cannot write.
- **Monitor-only vs manageable.** A device is *manageable* only when you give
  it a separate, explicit **write credential** (RouterOS `group=write` or
  `full`). Monitoring keeps using the read credential; writes use the write
  one. No silent privilege escalation — a monitor-only device shows config
  read-only with an "add write credentials to manage" prompt.
- **Every write goes through safe-apply:**
  **snapshot → confirm → apply → verify → auto-rollback on failure → audit.**
  Verify checks both that management survived (the device still answers) *and*
  that the change took; if either fails, the change is automatically rolled
  back to the pre-change snapshot. Input is validated before anything is sent
  (subnet membership, duplicate MAC/IP, format) — bad input is rejected, never
  pushed.
- **Audit log.** Every write — applied, rolled-back, failed, or rejected — is
  recorded with actor, device, before/after, and outcome (see the Audit page).

The first features riding this framework are DHCP reservations, the managed
firewall, and config restore; VLAN and interface config will reuse it too.

### Config backup & restore

- **Backup is read-safe.** On a manageable device RubyMIK captures the
  canonical RouterOS text export (faithful + importable); on a monitor-only
  device it captures a read-only GET reconstruction of the key config (nothing
  is written to the device — not even a temp file). Both are self-describing
  (device, model, serial, RouterOS version), gzip-compressed into SQLite
  (a large router's export compresses ~10×), retained to the last N per device.
- **Scheduled + manual + diff + download.** A low-frequency backup timer runs
  independently of the metrics poller (it never disturbs the monitoring
  cadence). Any two backups of a device can be diffed ("what changed since last
  week?") and any backup downloaded as an `.rsc`.
- **Restore** runs through the safe-apply dead-man (snapshot → apply → verify
  mgmt reachable → auto-rollback → audit) and is guarded against restoring one
  device's config onto another (identity/serial mismatch is refused). Restore
  is a write — monitor-only devices refuse it (403).

> **RouterOS constraints (honest scope):** `/export` requires the `ftp` policy,
> so backups of a manageable device use its write/management credential; a plain
> read credential can only produce the GET snapshot. A text export is a list of
> `add` commands and is **not** idempotent (re-running it aborts on the first
> existing item), and there is no ftp-free way to pull a binary backup or do a
> clean wipe-replace over REST. RubyMIK therefore restores by **idempotent
> reconcile** of the config it models (DHCP static reservations today); the
> full ruleset is preserved in the backup for diff/download, and bit-for-bit
> whole-device restore (reset-and-import / binary backups) is on the roadmap.

### Managed firewall — never sever the management path

Firewall config can lock you out of a router, so it has two extra structural
protections on top of the pipeline:

1. **mgmt-accept is always first.** The generator (`server/src/firewall.ts`)
   *always* emits the management-accept rules — accept established/related,
   accept each management source, accept the trusted interface — as the first
   rules of the input chain, before any drop. It's built into the generator,
   not something a preset or custom rule can reorder. A custom "drop-all" is
   structurally placed *below* the guard and can never sit above it.
2. **Dead-man auto-revert.** After applying, RubyMIK re-verifies that
   management is still reachable *and* that the rules took, retrying for a
   dead-man window; if the path is lost or the change didn't take, it
   auto-reverts to the pre-change snapshot. Presets are constrained, tagged
   `RUBYMIK:`, reconciled idempotently (never stacked), and cleanly removable.

> **RouterOS device-mode note:** the strongest on-device dead-man (a scheduler
> that reverts config even if the controller is fully locked out) needs
> RouterOS `scheduler` enabled in device-mode, which requires a one-time
> physical confirmation on the device. Where that isn't enabled, RubyMIK relies
> on the mgmt-accept-first guard plus its controller-side timed verify/revert.

## Polling at scale

The poller is designed so a large fleet doesn't get hammered and one dead
device can't stall the rest: poll launches are staggered (250ms spacing),
parallelism is capped (`RUBYMIK_POLL_CONCURRENCY`), every device has its own
10s timeout, and an over-long cycle causes the next tick to be skipped with a
warning — never a pile-up. Status is one UPSERTed row per device and recent
history is pruned to 24h, so SQLite stays comfortable. For very large fleets,
SNMP is a candidate lighter-weight polling path on the roadmap; REST is the
polling path today.

## Running without Docker

Node.js ≥ 22.13 (SQLite is built into Node — no native modules, no external DB):

```bash
npm --prefix web ci && npm --prefix server ci
npm run build
npm start        # serves API + dashboard on :8080
```

## Development

```bash
npm --prefix server ci && npm --prefix web ci
npm run dev:server   # API on :8080 (tsx watch)
npm run dev:web      # Vite dev server on :5173, proxies /api → :8080
```

Multi-arch images (amd64 / arm64 / armv7) build with `docker buildx` — see
[Dockerfile](Dockerfile). All dependencies are pure JavaScript, so cross-builds
need no native compilation.

## Roadmap

- More config features on the safe-apply framework: firewall rules, VLANs,
  interface config, backups — each reusing snapshot → verify → rollback → audit
- Deeper time-series (retention beyond 6h, roll-ups) and historical dashboards
- Email (SMTP) notification channel; per-site / per-device alert-rule overrides
  (the rules schema already carries the scope columns)
- Per-user site scoping / multi-tenant login (the schema and query layer are
  already built around site scoping — see `server/src/scope.ts`)
- SNMP as a lighter-weight polling option for very large fleets
- RouterOS 6.x legacy API (port 8728) support
- Device discovery / network scan for bulk adding
- Optional Postgres backend, WireGuard remote devices

## License

[MIT](LICENSE) © Rubynet (Pty) Ltd — RubyMIK is a RubyNet open-source project.
