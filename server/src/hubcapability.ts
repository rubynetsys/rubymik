import fs from 'node:fs';

/**
 * ============================================================================
 *  HUB CAPABILITY PRE-CHECK (P45)
 *
 *  Running the WireGuard hub needs a host-level privilege the container does NOT
 *  have by default: CAP_NET_ADMIN, as root, with WireGuard available on the host
 *  kernel. That is Docker's security boundary — RubyMIK cannot grant it to itself
 *  at runtime; the container must be RECREATED with it.
 *
 *  So the product must be HONEST about it BEFORE the click: detect the capability
 *  at page load and, if it's missing, show a setup card with a copy-paste-trivial
 *  fix for every deployment method — never let a click produce a raw RTNETLINK
 *  error. This module is the pure core of that check + the generated compose.
 * ============================================================================
 */

/** CAP_NET_ADMIN is capability bit 12 (linux/capability.h). */
export const CAP_NET_ADMIN = 12;

/** Pure: is CAP_NET_ADMIN set in a /proc/self/status CapEff hex mask? */
export function hasNetAdmin(capEffHex: string): boolean {
  const hex = capEffHex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  try {
    return (BigInt('0x' + hex) & (1n << BigInt(CAP_NET_ADMIN))) !== 0n;
  } catch {
    return false;
  }
}

/** Read the current process's effective CAP_NET_ADMIN from /proc (Linux only).
 *  Anything unreadable (non-Linux dev, no /proc) → false (treated as not-capable,
 *  which is the safe default — we'd rather show the setup card than fail a click). */
export function readNetAdmin(): boolean {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const m = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(status);
    return m ? hasNetAdmin(m[1]!) : false;
  } catch {
    return false;
  }
}

export interface CapabilityFacts {
  netAdmin: boolean;
  wgTool: boolean;
  /** true/false when probed; null when it couldn't be probed (no NET_ADMIN) — capable is false anyway. */
  wgKernel: boolean | null;
}

export interface HubCapability {
  capable: boolean;
  netAdmin: boolean;
  wireguard: boolean;
  reason: string;
  checks: { netAdmin: boolean; wgTool: boolean; wgKernel: boolean | null };
}

/** Pure: decide the capability verdict from gathered facts. NET_ADMIN is the
 *  primary (Docker-boundary) gate; the reason names the FIRST missing piece so
 *  the UI can say exactly what to fix. */
export function decideCapability(facts: CapabilityFacts): HubCapability {
  const { netAdmin, wgTool, wgKernel } = facts;
  const wireguard = wgTool && wgKernel === true;
  const capable = netAdmin && wireguard;
  let reason: string;
  if (!netAdmin) {
    reason = "This container can't manage a WireGuard interface — it's missing the NET_ADMIN capability (and must run as root). That's Docker's security boundary, not a RubyMIK limit: add it once with the setup below, then reload this page.";
  } else if (!wgTool) {
    reason = "The container has NET_ADMIN, but the `wg` command (wireguard-tools) isn't available in this image.";
  } else if (wgKernel === false) {
    reason = "The container has NET_ADMIN, but the host kernel has no WireGuard support — a test interface couldn't be created. WireGuard must be available on the host kernel (it is on modern Linux and Docker Desktop).";
  } else {
    reason = 'Ready — the container has NET_ADMIN, runs as root, and WireGuard is available. You can enable remote access.';
  }
  return { capable, netAdmin, wireguard, reason, checks: { netAdmin, wgTool, wgKernel } };
}

// ---------- The generated, ready-to-paste single-file compose (Portainer) ----------

const IMAGE_REPO = 'ghcr.io/rubynetsys/rubymik';

/** The actual running config, as detected from inside the container. The generated
 *  compose must reproduce THIS exactly and add ONLY the WireGuard lines — never
 *  assume 8080, never publish a port the install isn't already publishing. */
export interface RunningConfig {
  /** Running app version → the default image tag (RUBYMIK_IMAGE override still wins). */
  version: string;
  /** The host port the admin actually reaches the main service on (container :8080),
   *  detected from the request Host header. null → we could NOT detect it, and the
   *  file must say so rather than hardcode a wrong 8080. */
  mainHostPort: number | null;
  /** Is /offhost actually mounted in this container? If not, we must not add it. */
  offhost: boolean;
  /** The hub's UDP listen port — the ONE new published port the WG additions add. */
  listenPort: number;
}

/** Parse the host publish port from the request headers. Prefers a proxy's
 *  X-Forwarded-Port / -Host, else the Host header. Returns null when no explicit
 *  port is present (port 80/443 or unknowable behind a proxy) — the caller then
 *  emits a "set your host port" comment instead of a wrong default. Pure. */
export function parseHostPort(h: { host?: string | null; forwardedHost?: string | null; forwardedPort?: string | null }): number | null {
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  const first = (v?: string | null) => (v ? v.split(',')[0]!.trim() : '');
  const fp = first(h.forwardedPort);
  if (/^\d{1,5}$/.test(fp) && valid(Number(fp))) return Number(fp);
  const portOf = (v?: string | null): number | null => {
    const s = first(v);
    // host:port — the port is the trailing :NNNN (handles IPv6 "[::1]:8090" too).
    const m = /:(\d{1,5})$/.exec(s);
    if (!m) return null;
    const p = Number(m[1]);
    return valid(p) ? p : null;
  };
  return portOf(h.forwardedHost) ?? portOf(h.host);
}

/** Is `mountPoint` an actual mount in this container? Reads /proc/self/mountinfo
 *  (field 5 is the mount point). Anything unreadable → false. */
export function isMounted(mountPoint: string): boolean {
  try {
    const mi = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    return mi.split('\n').some((line) => line.split(' ')[4] === mountPoint);
  } catch {
    return false;
  }
}

/**
 * A COMPLETE, single-file compose = the DETECTED running service, reproduced, PLUS
 * (when includeWireguard) only the WireGuard lines: user/cap_add/devices/sysctls
 * and the one UDP port. It never assumes 8080 and never publishes a port the
 * install isn't already publishing — the main port comes from the detected host
 * port (or a "set this" comment), WebFig is an inert commented hint, and /offhost
 * appears only if it's actually mounted. `includeWireguard: false` renders the
 * running config alone (used to prove the diff is exactly the WG lines).
 */
export function generateHubCompose(cfg: RunningConfig, includeWireguard = true): string {
  const wg = includeWireguard;
  const imageDefault = `${IMAGE_REPO}:${cfg.version}`;
  const L: string[] = [];
  L.push('# ============================================================================');
  L.push('# RubyMIK — your CURRENT service, reproduced as detected, plus the WireGuard hub');
  L.push('# additions (the lines marked "WG:" below). Nothing else is changed: your ports,');
  L.push('# volumes and environment are reproduced as-is.');
  L.push('#');
  L.push('# APPLY (Portainer): Stacks -> your RubyMIK stack -> Editor -> replace the contents');
  L.push('# with this -> Update the stack. Then reload the Remote Access page: Enable is live.');
  L.push(`# Open UDP ${cfg.listenPort} on your host / cloud firewall so remote routers can dial in.`);
  L.push('# ============================================================================');
  L.push('services:');
  L.push('  rubymik:');
  L.push(`    image: \${RUBYMIK_IMAGE:-${imageDefault}}`);
  L.push('    container_name: rubymik');
  L.push('    restart: unless-stopped');
  L.push('    init: true');
  if (wg) {
    L.push('    user: "0:0"                     # WG: NET_ADMIN is only effective for root');
    L.push('    cap_add:');
    L.push('      - NET_ADMIN                   # WG: create/manage the WireGuard interface');
    L.push('    devices:');
    L.push('      - /dev/net/tun:/dev/net/tun   # WG: portability across kernels');
    L.push('    sysctls:');
    L.push('      - net.ipv4.ip_forward=1       # WG');
  }
  L.push('    ports:');
  if (cfg.mainHostPort != null) {
    L.push(`      - "${cfg.mainHostPort}:8080"`);
  } else {
    L.push('      # - "<HOST_PORT>:8080"          # set your host port here — could NOT auto-detect the port you reach RubyMIK on');
  }
  // Router Admin (WebFig) proxy port — must be browser-reachable, or "Router Admin"
  // shows "connection refused" (it did on public installs after v1.1.4 stopped
  // publishing it). Managing behind-NAT routers over the tunnel needs it, so a
  // WireGuard-hub stack publishes it; keep it on the container port so the app's
  // frame URL (host:8081) resolves. Remove ONLY if you never open Router Admin.
  L.push('      - "8081:8081"                 # Router Admin (WebFig) — needed to open a router\'s admin UI, incl. over the tunnel');
  if (wg) {
    // The hub's CONFIGURED listen port (not a hardcoded 51820). Host side is
    // overridable via RUBYMIK_WG_PORT for hosts that already run WireGuard on the
    // default; the container/advertised side stays the configured hub port.
    L.push(`      - "\${RUBYMIK_WG_PORT:-${cfg.listenPort}}:${cfg.listenPort}/udp"   # WG: routers dial this inbound`);
  }
  L.push('    environment:');
  L.push('      RUBYMIK_WEBFIG_PORT: ${RUBYMIK_WEBFIG_PORT:-8081}');
  L.push('      RUBYMIK_LOG_LEVEL: ${RUBYMIK_LOG_LEVEL:-info}');
  L.push('      RUBYMIK_POLL_INTERVAL: ${RUBYMIK_POLL_INTERVAL:-30}');
  L.push('      RUBYMIK_ENCRYPTION_KEY: ${RUBYMIK_ENCRYPTION_KEY:-}');
  L.push('      RUBYMIK_BACKUP_KEY: ${RUBYMIK_BACKUP_KEY:-}');
  L.push('      RUBYMIK_PUBLIC_URL: ${RUBYMIK_PUBLIC_URL:-}');
  L.push('    volumes:');
  L.push('      - rubymik-data:/data');
  if (cfg.offhost) L.push('      - rubymik-offhost:/offhost');
  L.push('');
  L.push('volumes:');
  L.push('  rubymik-data:');
  if (cfg.offhost) L.push('  rubymik-offhost:');
  L.push('');
  return L.join('\n');
}

/** The docker compose CLI path — the two-file override, unchanged. */
export function hubComposeCli(): string {
  return 'docker compose -f docker-compose.yml -f docker-compose.wireguard.yml up -d --build';
}
