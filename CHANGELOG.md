# Changelog

All notable changes to RubyMIK are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and RubyMIK follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The schema version each release migrates to is noted in parentheses — a release
whose schema version is higher than your running one will take a fail-closed
pre-migration backup on first boot (see `README-DEPLOY.md`).

## [Unreleased]

## [1.1.0] — 2026-07-23 (schema 24)

> **This release includes a database migration.** On first boot after upgrading, RubyMIK takes an
> automatic encrypted pre-migration backup — enabling backups for you if needed, so no
> configuration is required. **Strict-mode installs: have your recovery key ready before
> upgrading** — the boot-backup waits for you to provide it.

### Added
- **Dual-WAN failover (P42).** Recursive-route primary/backup WANs, with the router's own
  `check-gateway` doing the failover (~20–30s). A wizard previews the exact routes / NAT / mangle /
  routing-tables before a typed-confirm apply; the only verified-reachable default route can't be
  cut; per-device notifications (engaged / restored / both-down) with confirm-delay, hold-down and
  flap suppression. Timers gate ALERTS only — the router fails over on its own timing.
- **DNS content filtering (P43).** An optional Blocky resolver (deploy with one extra
  `-f docker-compose.filtering.yml`) with category toggles, custom block/allow rules and per-client
  exemptions, applied via a reload-verify. Per-device router enforcement forces LAN clients through
  the resolver — dst-nat `:53` → router DNS, DoT/DoH blocks, and a **raw-table WAN `:53` drop so the
  router is never left an open resolver** — guarded to match LAN client interfaces only, with
  fail-open / fail-closed and a resolver-health watchdog (a dead resolver alerts loudly).

### Changed
- **Backups now enable in one click from the UI; no configuration required.** RubyMIK generates the
  key, stores it in `/data`, and starts backing up immediately. The `RUBYMIK_BACKUP_KEY` env var is
  now advanced/optional (it still wins if set). Optional **strict mode** keeps the key off the
  server (in memory only). A schema upgrade auto-enables backups so a migration never needs compose
  surgery.

### Fixed
- **safe-apply now rolls back correctly when an apply step throws mid-operation.** Previously a
  multi-object change that failed part-way could leave partial writes on the device. The framework
  now restores the pre-change state on any mid-apply failure — this hardens every guarded write path
  (existing since the framework was introduced).

## [1.0.1] — 2026-07-22 (schema 22)

### Fixed
- **Device catalogue — RB5009 port count.** The RB5009 family (RB5009UG+S+IN,
  RB5009UPr+S+IN) was listed with 7 Ethernet ports; every variant has **8** (ether1 =
  2.5G, ether2-8 = 1G) plus one SFP+. A unit test now pins the RB5009* port lists.
- Corrected the high-speed cage types: **CCR2004** now includes its 2× 25G **SFP28**;
  **CCR2216** and **CRS518** are modelled as SFP28 (25G) / QSFP28 (100G), not SFP+/QSFP+;
  **hAP ac³/ax³** no longer carry a phantom SFP port.

### Changed
- **Model catalogue expanded** to the current MikroTik line (verified against
  mikrotik.com): 81 models across routers (hEX, RB9xx/RB951, RB2011/3011/4011/5009, L009,
  the CCR line), switches (CRS/CSS/netPower incl. CRS504/510/518), and wireless
  (hAP/cAP/wAP, LTE/Chateau, point-to-point CPE). New `sfp28`/`qsfp28` port types.
  "Other / not listed" remains the fallback.

## [1.0.0] — 2026-07-22 (schema 22)

The first **public** release — RubyMIK goes open-source (MIT), with a public landing
site (rubymik.com), a nightly-reset live demo (demo.rubymik.com), and container images
published to the public GHCR package.

### Added
- **Public launch:** open-source repository, landing site, and live demo. The in-app
  update check reads `rubymik.com/version.json`.

### Verified
- **Real PPPoE end-to-end on hardware** — a RubyMIK-created `pppoe-client` completes a
  genuine PPP negotiation to a real address over a bench loopback (the final go-live
  AMBER in `docs/GO-LIVE-READINESS.md`, now GREEN).

## [0.9.1] — 2026-07-22 (schema 20)

The Dockerization, migration-chain, and release-pipeline release. This is the
plumbing that makes RubyMIK installable and updatable with `docker compose`.

### Added
- **Boot upgrade-guard.** When the schema or the app version changes since the
  last boot, RubyMIK takes an automatic, encrypted pre-migration backup *before*
  applying any migration. It is fail-closed: if a required backup cannot be taken,
  the app refuses to start rather than migrate un-backed-up data.
- **In-app update check.** A daily, opt-out check against a small static
  `version.json` surfaces "a newer version is available" with a changelog link and
  the exact `docker compose pull && up -d` command. It sends nothing but the HTTP
  GET — no telemetry, no instance id — and never updates itself.
- **Update settings** (Account → Software updates, admin): current version, last
  check, a "Check now" button, and the daily-check toggle.
- **`/api/health`** now reports `version` and `schema` alongside `ok`.
- **`CHANGELOG.md`**, **`README-DEPLOY.md`**, a documented **`version.json`**
  contract, and **`scripts/release.sh`** (test → multi-arch build → tag → push to
  a private registry).
- **`schema_migrations` + `app_meta`** are now the single source of truth for the
  schema version and last-booted app version.

### Changed
- The migration runner refuses to start with a clear, actionable message when a
  migration fails (rolled back) or a required pre-migration backup cannot be taken.
- Consolidated confirmation that all schema history lives in one forward-only chain
  in `server/src/db.ts` — no ad-hoc schema mutations anywhere else.

### Notes
- **No down-migrations.** Rolling back a schema is done by restoring a backup and
  pinning the previous image tag — see `README-DEPLOY.md § Rollback`.
- The image remains `node:22-alpine` (not `node:20`): the built-in `node:sqlite`
  RubyMIK relies on requires Node ≥ 22.13, and 22 is the last line published for
  `linux/arm/v7`.

## [0.9.0] — baseline (schema 19)

The pre-Dockerization baseline: full monitoring, configuration management
(firewall, NAT, QoS, DHCP, routes, addresses, L2, PPPoE, VPN, wireless),
per-section snapshots + snapshot restore (P37), WireGuard remote access, sites,
roles + 2FA, notification channels, and RubyMIK's own encrypted DB self-backup
(P36). Ran bare-metal (`npm run build && npm start`); this is the last version
before the container/release machinery.

[Unreleased]: https://github.com/rubynetsys/rubymik/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/rubynetsys/rubymik/releases/tag/v0.9.1
[0.9.0]: https://github.com/rubynetsys/rubymik/releases/tag/v0.9.0
