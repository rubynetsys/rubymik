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
  Site-filterable, pan/zoom, updates on the poll cadence. **Scales to hundreds
  of devices across many sites**: a canvas renderer with level-of-detail —
  zoomed out, each site collapses to one status-dot cluster (device count +
  worst-health colour) so you read the whole fleet's shape at a glance; zoom in
  and sites expand to their real hierarchy (uplink → core → access → edge) with
  labels appearing progressively. Filter to problems-only or a device kind,
  search-to-jump, and focus a node to light its subtree and dim the rest — the
  reductions that keep a 500-device map readable. (Layout is a pure, swappable
  module; the renderer is canvas for scale.)
- **Device deep view** — click any device: live interfaces with RX/TX rates,
  per-interface traffic graphs (1h/6h), DHCP leases, ARP, routes, wireless
  registrations, switch ports, health/temperature, recent log — the
  RouterOS-native depth generic SNMP tools can't cleanly show. Sections
  capability-detect per device and say "not applicable" honestly instead of
  faking panels. Organised into **tabs** (Overview · Interfaces · Network ·
  DHCP · Firewall · DNS & NTP · Wireless · Backups · Logs · Router Admin) with the
  active tab in the URL (`#firewall`) so it survives refresh and deep-links; heavy
  tabs fetch only when opened, while Overview keeps live-polling.
- **Native wireless config** — view and configure Wi-Fi (SSID · enable/disable ·
  WPA2/WPA3 security · band/channel) on a manageable device, riding the same
  snapshot → verify → auto-rollback → audit safe-apply pipeline. RouterOS has two
  wireless stacks — modern `wifiwave2` (`/interface/wifi`, 7.13+) and legacy
  `/interface/wireless` — and RubyMIK **detects which the device runs and targets
  the right one** (a device with no radio says "no wireless" honestly). Passphrases
  are secrets: never shown in the UI, never logged, never written to the audit
  trail (it records "security changed", not the value). A wireless interface that
  carries the device's own management connection is flagged before you change it.
- **Native static-route config** — view the routing table (dst/gateway/distance/
  static-vs-dynamic-vs-connected) and add/edit/remove **static** routes, riding the
  same snapshot → verify → auto-rollback → audit pipeline with the **dead-man
  mandatory** — because a bad route can black-hole the very path RubyMIK manages
  the router through. A **transport-aware management-path guard** refuses the
  obvious mgmt-severing changes up front (the default route, or a route overlapping
  the subnet RubyMIK reaches the device on — the LAN subnet for a direct device,
  the WireGuard overlay for a tunnel device); anything subtler is caught post-apply
  by verify-reachability-then-commit-or-revert. RubyMIK-added routes are
  `RUBYMIK:`-tagged (idempotent, removable); dynamic/connected/protocol routes are
  read-only.
- **Native WireGuard VPN config** — configure the user's own WireGuard tunnels
  (site-to-site router↔router, or client), separate from RubyMIK's management
  tunnel: create interfaces (the router generates its **own** private key — RubyMIK
  never holds it), add/remove peers, assign tunnel addresses, and a site-to-site
  helper that emits the matched config for the far end. Optionally route traffic
  through a VPN, which **reuses the P17 route safe-apply + management-path guard +
  dead-man** (a default-through-VPN that would sever management is refused / auto-
  reverted). The P9 **management tunnel is protected** — a user-VPN change that
  would modify or reroute it is refused. Private/preshared keys are never shown,
  logged, or written to the audit.
- **Native interface / IP-address config** — view per-interface addresses (the
  management address flagged, static vs DHCP), add/remove addresses on non-mgmt
  interfaces, and change the management IP **safely**. Changing the address RubyMIK
  reaches a router on is a *total partition* — you can't revert what you can't
  reach — so the standard dead-man is insufficient and P19 uses **add-before-remove**
  instead: add the new address → verify RubyMIK can reach the *same* router there
  → only then remove the old one (and update RubyMIK's stored endpoint). If the new
  address doesn't verify, it's removed and the old one kept — the router is never
  left unreachable. Disabling the management interface, or hard-removing the only
  management address, is **refused** (instant unrecoverable partition). Tunnel
  devices get the same add-before-remove on their overlay address.
- **Router Admin (WebFig proxy)** — open the router's own built-in WebFig admin
  UI *through* RubyMIK, over whichever transport the device uses — including a
  behind-NAT router reachable only over the WireGuard tunnel. Auth-gated (only a
  logged-in, authorized user), and **target-by-device-id only**: the browser
  never supplies a host, so it can't be turned into an open proxy. Credentials
  are pass-through — you log in with the router's own login; RubyMIK never
  injects or stores it in the proxy path, so nothing leaks. Every open is
  audited. WebFig assumes web-root, so it is served on its own port (see
  `RUBYMIK_WEBFIG_PORT`).
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
- **DNS & NTP configuration** — view and set the resolver (servers,
  allow-remote-requests, cache), manage static DNS host entries, and enable the
  NTP client with sync status. Every change runs the safe-apply pipeline and is
  audited; monitor-only devices show DNS/NTP read-only.
- **Remote access over WireGuard** *(opt-in)* — manage routers that sit behind
  NAT with no direct path. RubyMIK runs a WireGuard hub the routers dial
  **outbound** into (no port-forward on the router side); once the tunnel is up,
  every feature — monitoring, DHCP, firewall, DNS/NTP, backup — works over it
  unchanged. **Off by default and invisible to the same-LAN experience.** See
  [Remote access](#remote-access-over-wireguard-behind-nat-sites).
- **Onboarding wizard** — a guided flow to bring an *existing, live* router under
  management (same-LAN or behind-NAT). Its default posture is **touch nothing**:
  monitoring is read-only, and you can complete it with RubyMIK making zero changes
  to the router. Any write is explicit, opt-in, and shown first. See
  [Onboarding](#onboarding-an-existing-router).
- **Provisioning wizard** — build a complete baseline for a *blank/factory* router
  (identity, LAN bridge, addressing, WAN, DHCP, NAT, firewall, and — for a remote
  site — the tunnel-back), with **ruthless validation** that refuses to emit an
  incoherent or lockout config. Generate a script the human applies once (safe,
  default), or live-apply it to a reachable blank router in safe order with the
  dead-man armed. See [Provisioning](#provisioning-a-new-blank-router).
- **Monitoring is read-only by design** — the monitoring client only issues GET
  requests to RouterOS (rates are derived from byte counters precisely because
  the monitor commands are POST). A `group=read` user is all monitoring needs.
  Configuration is a **separate, explicit** capability (see below).
- **Themes** — the whole UI is tokenized (semantic CSS variables — surfaces, text,
  borders, accent, status), so it ships six themes (Ruby light/dark, Modern
  dark/light with a pickable accent, Glass, Classic) that swap instantly with no
  per-component logic. Per-user choice, an install default, and CVD-safe status
  colours in every theme. See [Theming](#theming).

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
| `RUBYMIK_POLL_INTERVAL` | `30` | Seconds between health poll cycles (5–3600, or `0` to disable polling and serve stored data only) |
| `RUBYMIK_WEBFIG_PORT` | main port + 1 (`8081`) | Port for the WebFig router-admin reverse proxy (WebFig needs web-root, so it gets its own listener). Must be browser-reachable, like the main port. `0` disables the feature |
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

### DNS & NTP configuration

A gentle, settings-level config feature riding the same pipeline
(`server/src/netconfig.ts`):

- **DNS** — set the resolver's upstream servers, `allow-remote-requests`, and
  cache size, and manage static host entries (`/ip/dns/static`). DNS servers are
  validated as IPs (hostnames rejected); static entries require a valid hostname
  and IPv4. Enabling `allow-remote-requests` turns the router into a resolver for
  its clients — the UI flags that so it isn't toggled blindly.
- **NTP** — enable the client and set servers (IP or hostname), with live sync
  status. NTP servers legitimately take a few seconds to reach `synchronized`, so
  `verify` only confirms the *settings* took; actual synchronization is surfaced
  separately by polling the status, not gated on inside the apply.

Singleton menus (`/ip/dns`, `/system/ntp/client`) are written with a REST
`POST .../set`; static entries use the list verbs (PUT/PATCH/DELETE). As with
every config feature, monitor-only devices are read-only and a write is rejected
with `403` before the device is ever contacted.

## Onboarding an existing router

Most routers you'll add are **already live**, routing a client's real traffic. The
onboarding wizard (**Onboard** in the nav) brings one under management safely, and
its governing principle is **do no harm**: the default posture is touch nothing.

- **Two paths.** *Router on my network* (direct) or *Router at a remote site behind
  NAT* (tunnel, via the WireGuard hub). The wizard routes everything through the
  same transport layer, so the router is either a `direct` or a `tunnel` device and
  every feature works the same afterward.
- **Read-only by default.** The direct path is a pure monitoring attach — it
  connection-tests, identifies the device (model / RouterOS / serial), stores an
  encrypted **read** credential, assigns a site, and finishes. **Zero configuration
  is written to the router.** Providing a *write* credential is a separate, explicit
  choice that makes the device manageable later — it still writes nothing during
  onboarding.
- **The tunnel is the only additive change, and you see it first.** On the remote
  path the wizard generates the RouterOS bootstrap and shows *exactly* what it adds
  (a `rmik-wg` interface, an overlay IP, a peer, one RUBYMIK-tagged accept rule) —
  purely additive, nothing existing modified or removed, and cleanly removable. A
  human applies it once; the router generates its own key (the script holds no
  secret); RubyMIK detects the handshake and manages it over the tunnel.
- **Extras are opt-in and default OFF.** An initial backup (a read) and inclusion in
  scheduled backups are offered explicitly and skippable — skip them and RubyMIK
  touches nothing. (Config changes — firewall, DNS/NTP, etc. — are never bundled
  into onboarding; you make them deliberately later from the device page.)

The wizard ends with a plain statement of what was done and what was **not** touched.

## Provisioning a new (blank) router

Where onboarding attaches to a *live* router, the **provisioning wizard**
(`server/src/provision.ts`) builds a *blank/factory* one from nothing: identity,
LAN bridge + ports, addressing, WAN (DHCP client / static / PPPoE), DHCP server,
NAT, firewall, and — for a remote site — the WireGuard tunnel-back. This is the
highest-stakes config in RubyMIK, so it's built around two disciplines:

- **Ruthless validation.** Before it generates anything, `validateSpec` proves the
  whole spec is internally coherent and **refuses** otherwise, with specific errors:
  DHCP pool inside the LAN subnet, no WAN/LAN overlap, no double-assigned interface,
  the router's own IP excluded from the pool, static WAN has IP/gw/dns, PPPoE has
  credentials, sane subnets/leases. It never emits a config it can't prove correct.
- **The firewall can't lock you out.** The generated firewall is P6's — so it
  *always* leads with the management-accept guard. A provisioned router can never
  come up locked out of management.

Two application modes:

- **Mode A — generate a script (safe, and the default).** The wizard produces the
  complete baseline as a RouterOS script; a human applies it once to the blank
  router. RubyMIK applies nothing live, so there's no mid-build lockout risk. For a
  **remote/behind-NAT** router this is the *only* mode (the tunnel-back is part of
  the baseline, so the router dials in once it's applied); RubyMIK then adopts it
  over the tunnel. Requires the hub enabled for the remote case.
- **Mode B — live-apply (LAN-only).** For a blank router already reachable on the
  LAN, RubyMIK applies the baseline itself, in **safe order** — management first,
  the lockout-capable firewall **last** (through the P6 dead-man), every step
  verified before the next. If any step severs management, the baseline is unwound
  (the router goes back toward blank/reachable, never orphaned half-configured) and
  the failing step is reported.

Everything reuses the proven primitives — the firewall is P6's generator, the
tunnel is P9's bootstrap, the safe-apply/dead-man is P5/P6, adoption is P10's — so
this phase validates, generates, and orchestrates rather than re-deriving rules.

## Remote access over WireGuard (behind-NAT sites)

RubyMIK can also manage routers it has **no direct network path to** — a router
behind NAT at a remote site — by acting as a WireGuard hub the routers dial
**outbound** into. This turns RubyMIK into a self-hosted cloud controller as well
as a same-LAN tool. It is **opt-in and off by default**, and it never touches the
zero-config LAN experience.

**The transport abstraction is the whole design.** Every device is reached over
one of two transports, resolved centrally in `server/src/transport.ts`:

- **direct** — the device's LAN address (`host`). The default, and the only thing
  a same-LAN deployment ever uses.
- **tunnel** — a WireGuard overlay IP (`tunnel_ip`), for a behind-NAT device.

The monitoring GET client and the write module both build their target through
`resolveEndpoint()`, so *every* feature — monitoring, DHCP, firewall, DNS/NTP,
backup — works over either transport with **no per-feature code**. A device that
never opts into WireGuard has `net_transport = 'direct'` and behaves exactly as it
did before this feature existed.

**Solving the chicken-and-egg (the outbound dial).** RubyMIK can't push config to
a router it can't reach. So onboarding is one human step:

1. In RubyMIK, add a remote site → it allocates an overlay IP and generates a
   one-time **RouterOS bootstrap script**.
2. A human applies that script once on the router (WinBox terminal / SSH, on-site
   or via existing access). It creates a WireGuard interface that dials the hub
   **outbound** (traverses NAT — no port-forward on the router side), assigns the
   overlay IP, and adds a minimal accept rule so RubyMIK can manage it over the
   tunnel.
3. The script prints the router's public key; paste it back into RubyMIK to
   finish. The tunnel comes up and RubyMIK manages the router over the overlay
   from then on.

**Key handling (security).** The **router generates its own private key** — it
never leaves the router, so the bootstrap script contains no secret (only the
hub's *public* key + endpoint). The **only** private key RubyMIK stores is the
hub's, AES-GCM encrypted at rest, decrypted in memory only to configure the
interface (via a 0600 temp file deleted immediately) and never logged.

**Docker requirement (honest).** The hub uses kernel WireGuard, which needs the
container run with `NET_ADMIN`, as root, and the UDP port published. Those are
**not** in the base image/compose — they're an opt-in override so a home-lab
`docker run` is unaffected:

```
docker compose -f docker-compose.yml -f docker-compose.wireguard.yml up -d --build
```

Open the UDP port (default 51820) on your host/cloud firewall, and set RubyMIK's
reachable endpoint in **Remote Access**. The WireGuard kernel module must be
available on the host (it is on modern Linux and Docker Desktop); if it isn't, the
hub reports the error honestly and the rest of RubyMIK keeps working.

> **Tested vs. real-world.** This was validated by having a real MikroTik dial the
> hub and then managing it **exclusively over the overlay IP** (direct path unused;
> killing the tunnel makes only the tunnel device go unreachable). The hub ran on a
> dev host standing in for a VPS. A public-VPS-to-real-remote-NAT deployment is the
> real-world validation; the mechanism (outbound dial + hub) is identical.

## Theming

The UI is **fully tokenized**: every component references semantic design tokens
(`bg-surface`, `text-fg`, `bg-accent`, `text-success-fg`, `border-border`, …),
never a raw palette shade. The tokens are CSS custom properties defined in
`web/src/styles.css`; a **theme is just a set of token values** applied at
`:root[data-theme=…]`, so switching theme swaps the values instantly and a new
component works in every theme automatically (it only ever names tokens).

Six themes ship: **Ruby** (light, the default and unchanged brand look), **Ruby
Dark**, **Modern Dark** and **Modern Light** (neutral, with a user-pickable
accent), **Glass** (frosted translucency over a soft gradient), and **Classic** (a
dense utilitarian grey admin aesthetic — its own look, not a clone of any vendor
tool). The Modern themes derive their accent tints via `color-mix` from a single
`--accent`, so the **accent picker** (blue / red / green / purple / amber / teal)
re-tints everything at once while keeping button-text contrast legible.

- **Status stays accessible.** `--success/--warning/--danger/--info` keep
  CVD-validated hues in every theme and are always shown as **icon + label**, never
  colour alone.
- **Selection.** An instance default theme (`RUBYMIK_DEFAULT_THEME`, defaults to
  `ruby-light`); each user can override it (stored on the user, `null` = use the
  default). The choice is applied before first paint by a tiny inline script (no
  flash-of-wrong-theme) and re-synced from the server on load.

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

**Synthetic fleet (topology scale/demo testing).** To see the topology map at
hundreds of devices without hundreds of routers, a generator populates a
**fresh, throwaway** data dir with fabricated sites/devices/neighbours. It is
test-only and guarded three ways — it requires `RUBYMIK_SYNTH_OK=1`, refuses to
run against a DB that already has devices, and is never imported by the running
server ([server/src/devtools/](server/src/devtools/)). It fabricates no RouterOS
traffic; run the throwaway instance with `RUBYMIK_POLL_INTERVAL=0`:

```bash
# against an EMPTY /data volume only — never a real instance
docker run --rm -v scratch:/data -e RUBYMIK_SYNTH_OK=1 -e RUBYMIK_DATA_DIR=/data \
  rubymik/rubymik node dist/devtools/gen-synth.js 500 28   # 500 devices, 28 sites
docker run -d -v scratch:/data -e RUBYMIK_POLL_INTERVAL=0 -p 8081:8080 rubymik/rubymik
```

## Roadmap

- More config features on the safe-apply framework: VLANs and interface config —
  each reusing snapshot → verify → rollback → audit (firewall, backups, and
  DNS/NTP already ship on it)
- Remote-access UX: a browser WinBox-style terminal over the tunnel, per-site
  firewall hardening applied over WireGuard (the tunnel plumbing, transport
  abstraction, and the existing-router onboarding wizard already ship)
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
