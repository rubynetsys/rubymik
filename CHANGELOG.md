# Changelog

All notable changes to RubyMIK are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and RubyMIK follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The schema version each release migrates to is noted in parentheses — a release
whose schema version is higher than your running one will take a fail-closed
pre-migration backup on first boot (see `README-DEPLOY.md`).

## [Unreleased]

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
