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

export interface HubComposeOptions {
  /** Running app version → the default image tag (their actual current tag). */
  version: string;
  /** The hub's UDP listen port to publish. */
  listenPort: number;
  mainPortDefault?: number;
  webfigPortDefault?: number;
}

/**
 * A COMPLETE, single-file compose = the base RubyMIK service + the WireGuard
 * additions (NET_ADMIN, root, /dev/net/tun, sysctl, the UDP port). Built to be
 * pasted whole into a Portainer stack editor. Data volumes and env keep the same
 * names/interpolation, so nothing is lost. Image + UDP port reflect the running
 * install. RUBYMIK_IMAGE, if the operator set it, still wins (custom images).
 */
export function generateHubCompose(opts: HubComposeOptions): string {
  const main = opts.mainPortDefault ?? 8080;
  const webfig = opts.webfigPortDefault ?? 8081;
  const udp = opts.listenPort;
  const imageDefault = `${IMAGE_REPO}:${opts.version}`;
  return `# ============================================================================
# RubyMIK — WireGuard remote-access ENABLED (single file, for Portainer or any
# stack editor). This is your service PLUS the one server-side step WireGuard
# needs: NET_ADMIN, root, the UDP port, and /dev/net/tun.
#
# HOW TO APPLY (Portainer): Stacks -> your RubyMIK stack -> Editor -> replace the
# contents with this -> "Update the stack". Your data volumes and environment are
# preserved (same names). Then reload the Remote Access page: Enable is clickable.
#
# Open UDP ${udp} on your host / cloud firewall so remote routers can dial in.
# ============================================================================
services:
  rubymik:
    image: \${RUBYMIK_IMAGE:-${imageDefault}}
    container_name: rubymik
    restart: unless-stopped
    init: true
    # --- WireGuard hub additions (only these differ from the LAN-only base) ---
    user: "0:0"
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    sysctls:
      - net.ipv4.ip_forward=1
    ports:
      - "\${RUBYMIK_PORT:-${main}}:${main}"
      - "\${RUBYMIK_WEBFIG_PORT:-${webfig}}:${webfig}"
      - "${udp}:${udp}/udp"
    environment:
      RUBYMIK_WEBFIG_PORT: ${webfig}
      RUBYMIK_LOG_LEVEL: \${RUBYMIK_LOG_LEVEL:-info}
      RUBYMIK_POLL_INTERVAL: \${RUBYMIK_POLL_INTERVAL:-30}
      RUBYMIK_ENCRYPTION_KEY: \${RUBYMIK_ENCRYPTION_KEY:-}
      RUBYMIK_BACKUP_KEY: \${RUBYMIK_BACKUP_KEY:-}
      RUBYMIK_PUBLIC_URL: \${RUBYMIK_PUBLIC_URL:-}
    volumes:
      - rubymik-data:/data
      - rubymik-offhost:/offhost

volumes:
  rubymik-data:
  rubymik-offhost:
`;
}

/** The docker compose CLI path — the two-file override, unchanged. */
export function hubComposeCli(): string {
  return 'docker compose -f docker-compose.yml -f docker-compose.wireguard.yml up -d --build';
}
