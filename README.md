# RubyMIK

**Modern, self-hosted monitoring for MikroTik RouterOS — think "The Dude", reimagined.**

RubyMIK is an open-source dashboard for monitoring (and soon, configuring) your MikroTik
devices. It runs anywhere Docker runs — a Linux server, a Raspberry Pi, a Mac — talks to
your routers directly over the LAN via the RouterOS REST API, and needs **no external
database, no cloud account, no tunnels**. Clone it, run it, add a router. Done.

> ⚠️ **Early days:** this is the P0 skeleton — auth, the device connection layer, and the
> dashboard shell. Live monitoring, graphs, and alerting are landing next.

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

Device credentials are stored **AES-256-GCM encrypted** in SQLite — never plaintext.

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

- Live device monitoring: interfaces, traffic graphs, wireless, DHCP leases
- Multiple devices at a glance, status polling, alerting
- RouterOS 6.x legacy API (port 8728) support
- Configuration actions (guarded), backups
- Optional Postgres backend, multi-user/tenant, WireGuard remote devices

## License

[MIT](LICENSE) © Rubynet (Pty) Ltd — RubyMIK is a RubyNet open-source project.
