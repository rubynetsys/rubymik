# Your first router — a safe onboarding runbook

This is the customer-facing runbook for adding your **first** MikroTik to RubyMIK
and turning on configuration safely. Follow it in order. It takes about ten minutes
and never puts your router at risk of being locked out.

The golden rule: **monitor first, configure second.** RubyMIK deliberately splits
those into two credentials so you can prove monitoring works before anything can
write to the router.

---

## Step 0 — before you touch RubyMIK

On the router (WinBox/WebFig/terminal), decide the address RubyMIK will reach it on:

- **Same LAN** as RubyMIK → the router's LAN IP (e.g. `192.168.88.1`).
- **Behind NAT / another site** → set up Remote Access (WireGuard) first; RubyMIK
  reaches the router on its overlay IP. (See the Remote Access page.)

Make sure the RouterOS **REST API is reachable** from the RubyMIK host: the `www`
(HTTP) or `www-ssl` (HTTPS) service must be enabled. Test from the RubyMIK host:

```bash
curl -sk -u <user>:<pass> https://<router-ip>/rest/system/resource   # or http:// for www
```

If that returns JSON, RubyMIK can talk to it.

---

## Step 1 — create a READ-ONLY user on the router (monitoring)

Monitoring only ever issues GET requests. Give it a least-privilege, **read-only**
account — never your `admin` login.

```
/user group add name=rubymik-read policy=read,api,rest,winbox
/user add name=rubymik-mon group=rubymik-read password=<a strong password>
```

> Why a separate read user: if this credential ever leaked, it cannot change your
> router — it can only read. RubyMIK stores it AES-256-encrypted at rest.

---

## Step 2 — add the device to RubyMIK as MONITOR-ONLY

**Add device** → enter the name, the host/IP, and the **read-only** credential from
Step 1. Leave the *write* credential blank. Save.

The device is now **monitor-only**: RubyMIK polls it, draws its interfaces, health,
topology, DHCP leases, routes — everything read-only. Every configuration panel
shows read-only with a "add a write credential to configure" note. Nothing on the
router can change yet.

---

## Step 3 — VERIFY polling before you go further

Do not add a write credential until monitoring is proven. Confirm:

- The device shows **up** (green) on the dashboard within a poll cycle (~30 s).
- Its **Overview** shows real CPU/memory/uptime and the RouterOS version.
- **Interfaces** list with live RX/TX; **Topology** places the device.

If it shows **down**, fix that first (wrong IP, REST service off, firewall blocking
the RubyMIK host, wrong password) — a device that can't be monitored certainly
can't be safely configured.

---

## Step 4 — create a WRITE user on the router (configuration)

Only when you actually want RubyMIK to *change* config, create a second, **write**
account — again, not your personal `admin`:

```
/user group add name=rubymik-write policy=read,write,api,rest,winbox,policy,sensitive
/user add name=rubymik-cfg group=rubymik-write password=<a different strong password>
```

Then in RubyMIK: open the device → **Edit** → add the **write** credential. The
device becomes **manageable** and the config panels unlock. Monitoring keeps using
the read credential; the write credential is used *only* by the guarded apply
pipeline.

> Two credentials, two jobs. You can run forever monitor-only. Adding the write
> credential is a deliberate, reversible step.

---

## What the guards will refuse — and why

Every write runs through **safe-apply**: snapshot → apply → verify the router is
still reachable → auto-rollback if not → audit. On top of that, RubyMIK **refuses
up front** any change it can prove would cut its own management path. You will see a
clear refusal (HTTP 409) rather than a lockout. The common ones:

| You try to… | RubyMIK refuses because… |
|---|---|
| Put a PPPoE/DHCP client, or disable, the interface RubyMIK manages the router on | it would sever the management path (a total partition RubyMIK couldn't undo) |
| Add a default route / a route over RubyMIK's own subnet or WireGuard overlay | it would black-hole the management path |
| Delete/disable the management bridge or VLAN, or enable vlan-filtering on the mgmt bridge without carrying the mgmt VLAN | the classic RouterOS self-lock, below the IP layer |
| A firewall preset without a management-accept rule | RubyMIK always emits the mgmt-accept rule **first** so a preset can't lock it out |
| A QoS queue that would strangle the mgmt IP/interface (or 0.0.0.0/0 under 1 Mbps) | it would throttle management to death |
| Edit an object RubyMIK didn't create (unmanaged) | you must **take ownership** explicitly first — no silent adoption |

Changing the **management IP or L2 path** itself isn't refused — it uses
**add-before-remove**: RubyMIK builds the new path, verifies the *same* router still
answers there, and only then removes the old one. If the new path doesn't verify,
it's torn down and the old one kept. The router is never left unreachable.

If a change *does* drop the management path despite the up-front checks, the
**dead-man** notices within seconds and auto-reverts to the pre-change snapshot.

---

## Where your snapshots and backups live

- **Config snapshots** (P21/P37): RubyMIK captures a RouterOS `/export` snapshot
  **before and after every write**, plus daily and on-demand. They're encrypted at
  rest and let you **diff** any change and **restore** section-by-section (through
  the same guards). Device → **Backups / Snapshots**.
- **Config backups**: scheduled per-device `/export` backups you can download.
- **RubyMIK's own database backup**: separate from the routers — an encrypted,
  restore-tested backup of RubyMIK's DB (devices, credentials, audit, snapshots).
  See the **Backup** page and `README-DEPLOY.md`.

Every configuration write — who, what, before → after, and the outcome — is on the
**Audit** page, read-only, forever (pruned to 180 days).

---

## Recap

1. Read-only user on the router → add device **monitor-only**.
2. **Verify** it polls (up, metrics, topology).
3. Only then, write user on the router → add the write credential → **manageable**.
4. Make changes; the guards + dead-man keep you from locking yourself out; every
   change is snapshotted and audited.

Monitor first. Configure second. Let the guards do their job.
