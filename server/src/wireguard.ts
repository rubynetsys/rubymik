import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretBox } from './secretbox.js';
import { log } from './log.js';

/**
 * ============================================================================
 *  THE WIREGUARD HUB (P9) — opt-in remote-access keystone.
 *
 *  RubyMIK can run a WireGuard hub that behind-NAT routers dial OUTBOUND into,
 *  so it can manage them over a stable overlay IP without any port-forward on
 *  the router side. This is ENTIRELY opt-in: when the hub is disabled (the
 *  default) nothing here runs, no interface is created, and the zero-config LAN
 *  experience is byte-for-byte unchanged.
 *
 *  Security posture (acceptance H):
 *   - The ONLY private key RubyMIK stores is the hub's, AES-GCM encrypted at
 *     rest (private_key_enc). It is decrypted in-memory only to configure the
 *     interface, written to a 0600 temp file that is deleted immediately, and
 *     NEVER logged or returned over the API.
 *   - Routers generate their OWN private keys (in the bootstrap, on the router).
 *     RubyMIK only ever stores a router's PUBLIC key. Bootstrap scripts thus
 *     contain no secrets.
 *
 *  Runtime: kernel WireGuard via `wg`/`ip`, which needs the container to have
 *  NET_ADMIN and a published UDP port. Those are supplied by an opt-in compose
 *  override (see docker-compose.wireguard.yml) — the base image/compose never
 *  requires them, so a plain `docker run` for a home lab is unaffected.
 * ============================================================================
 */

export const WG_IFACE = 'rmik-wg0';

interface HubRow {
  id: number;
  enabled: number;
  endpoint: string | null;
  listen_port: number;
  overlay_cidr: string;
  hub_address: string;
  private_key_enc: string | null;
  public_key: string | null;
}

export interface HubStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  endpoint: string | null;
  listenPort: number;
  overlayCidr: string;
  hubAddress: string;
  publicKey: string | null;
  /** Non-null when the interface can't run (e.g. missing NET_ADMIN) — surfaced honestly. */
  runtimeError: string | null;
  peers: PeerStatus[];
}

export interface PeerStatus {
  publicKey: string;
  endpoint: string | null;
  latestHandshakeUnix: number;
  rxBytes: number;
  txBytes: number;
  /** never | recent | stale — derived from the last handshake age. */
  state: 'never' | 'recent' | 'stale';
}

const HANDSHAKE_RECENT_SEC = 180;

/** Run a command with an argv array (no shell → no injection). Optional stdin.
 *  Returns {code, stdout, stderr}. Never interpolates secrets into argv. */
function run(cmd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    p.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) { p.stdin.write(stdin); }
    p.stdin.end();
  });
}

/** Generate a fresh WireGuard keypair. The private key is returned to the
 *  caller for immediate encryption; it is never logged. */
export async function generateKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  const gen = await run('wg', ['genkey']);
  if (gen.code !== 0) throw new Error(`wg genkey failed: ${gen.stderr.trim() || 'is wireguard-tools installed?'}`);
  const privateKey = gen.stdout.trim();
  const pub = await run('wg', ['pubkey'], privateKey);
  if (pub.code !== 0) throw new Error(`wg pubkey failed: ${pub.stderr.trim()}`);
  return { privateKey, publicKey: pub.stdout.trim() };
}

/** Prefix length from a CIDR string (e.g. "10.9.0.0/24" → 24). */
function prefixLen(cidr: string): number {
  const n = Number(cidr.split('/')[1]);
  return Number.isInteger(n) ? n : 24;
}

export class WireguardHub {
  constructor(private readonly db: DatabaseSync, private readonly box: SecretBox) {}

  private row(): HubRow | undefined {
    return this.db.prepare('SELECT * FROM wg_hub WHERE id = 1').get() as unknown as HubRow | undefined;
  }

  isConfigured(): boolean {
    const r = this.row();
    return !!(r && r.private_key_enc && r.public_key);
  }

  isEnabled(): boolean {
    return this.row()?.enabled === 1;
  }

  /** Create/refresh the hub config and ensure a keypair exists. Idempotent. */
  async configure(input: { endpoint: string; listenPort: number; overlayCidr?: string; hubAddress?: string }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.row();
    let priv: string | null = existing?.private_key_enc ?? null;
    let pub: string | null = existing?.public_key ?? null;
    if (!priv || !pub) {
      const kp = await generateKeypair();
      priv = this.box.encrypt(kp.privateKey);
      pub = kp.publicKey;
      log.info('Generated WireGuard hub keypair (private key encrypted at rest)');
    }
    const overlay = input.overlayCidr ?? existing?.overlay_cidr ?? '10.9.0.0/24';
    const hubAddr = input.hubAddress ?? existing?.hub_address ?? '10.9.0.1';
    if (existing) {
      this.db.prepare(`UPDATE wg_hub SET endpoint=?, listen_port=?, overlay_cidr=?, hub_address=?, private_key_enc=?, public_key=?, updated_at=? WHERE id=1`)
        .run(input.endpoint, input.listenPort, overlay, hubAddr, priv, pub, now);
    } else {
      this.db.prepare(`INSERT INTO wg_hub (id, enabled, endpoint, listen_port, overlay_cidr, hub_address, private_key_enc, public_key, created_at, updated_at)
        VALUES (1, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.endpoint, input.listenPort, overlay, hubAddr, priv, pub, now, now);
    }
  }

  /** Bring the hub interface up (idempotent). Requires enabled + configured. */
  async up(): Promise<void> {
    const r = this.row();
    if (!r || !r.private_key_enc) throw new Error('Hub is not configured.');
    if (await this.ifaceExists()) { await this.syncPeers(); return; }

    const priv = this.box.decrypt(r.private_key_enc);
    const keyFile = path.join(os.tmpdir(), `rmik-wg-${process.pid}.key`);
    try {
      fs.writeFileSync(keyFile, priv, { mode: 0o600 });
      let res = await run('ip', ['link', 'add', 'dev', WG_IFACE, 'type', 'wireguard']);
      if (res.code !== 0) throw new Error(`ip link add failed: ${res.stderr.trim()} (does the container have NET_ADMIN and the wireguard kernel module?)`);
      res = await run('wg', ['set', WG_IFACE, 'listen-port', String(r.listen_port), 'private-key', keyFile]);
      if (res.code !== 0) throw new Error(`wg set failed: ${res.stderr.trim()}`);
      res = await run('ip', ['address', 'add', `${r.hub_address}/${prefixLen(r.overlay_cidr)}`, 'dev', WG_IFACE]);
      if (res.code !== 0 && !res.stderr.includes('File exists')) throw new Error(`ip address add failed: ${res.stderr.trim()}`);
      res = await run('ip', ['link', 'set', 'up', 'dev', WG_IFACE]);
      if (res.code !== 0) throw new Error(`ip link set up failed: ${res.stderr.trim()}`);
      log.info(`WireGuard hub up on ${WG_IFACE} (${r.hub_address}, udp/${r.listen_port})`);
    } finally {
      fs.rmSync(keyFile, { force: true }); // never leave key material on disk
    }
    await this.syncPeers();
  }

  /** Tear the hub interface down (idempotent). */
  async down(): Promise<void> {
    if (!(await this.ifaceExists())) return;
    const res = await run('ip', ['link', 'del', 'dev', WG_IFACE]);
    if (res.code !== 0 && !res.stderr.includes('Cannot find device')) {
      log.warn(`WireGuard hub down: ${res.stderr.trim()}`);
    } else {
      log.info('WireGuard hub down');
    }
  }

  private async ifaceExists(): Promise<boolean> {
    return (await run('ip', ['link', 'show', WG_IFACE])).code === 0;
  }

  /** Push the registered peer set onto the live interface (idempotent reconcile). */
  async syncPeers(): Promise<void> {
    if (!(await this.ifaceExists())) return;
    const peers = this.db.prepare(`SELECT public_key, tunnel_ip FROM wg_peers WHERE public_key IS NOT NULL`).all() as Array<{ public_key: string; tunnel_ip: string }>;
    const want = new Set(peers.map((p) => p.public_key));
    for (const p of peers) {
      const res = await run('wg', ['set', WG_IFACE, 'peer', p.public_key, 'allowed-ips', `${p.tunnel_ip}/32`]);
      if (res.code !== 0) log.warn(`wg set peer failed for ${p.tunnel_ip}: ${res.stderr.trim()}`);
    }
    // Remove peers no longer registered.
    for (const live of await this.dumpPeers()) {
      if (!want.has(live.publicKey)) {
        await run('wg', ['set', WG_IFACE, 'peer', live.publicKey, 'remove']);
      }
    }
  }

  private async dumpPeers(): Promise<PeerStatus[]> {
    const res = await run('wg', ['show', WG_IFACE, 'dump']);
    if (res.code !== 0) return [];
    // First line is the interface; peer lines: pubkey, psk, endpoint, allowed-ips, latest-handshake, rx, tx, keepalive
    const now = Math.floor(Date.now() / 1000);
    return res.stdout.trim().split('\n').slice(1).filter(Boolean).map((line) => {
      const f = line.split('\t');
      const hs = Number(f[4]) || 0;
      const age = hs === 0 ? Infinity : now - hs;
      return {
        publicKey: f[0]!,
        endpoint: f[2] && f[2] !== '(none)' ? f[2] : null,
        latestHandshakeUnix: hs,
        rxBytes: Number(f[5]) || 0,
        txBytes: Number(f[6]) || 0,
        state: hs === 0 ? 'never' : age <= HANDSHAKE_RECENT_SEC ? 'recent' : 'stale',
      } as PeerStatus;
    });
  }

  /** Full hub status incl. live per-peer handshake state. Never returns key material. */
  async status(): Promise<HubStatus> {
    const r = this.row();
    const base: HubStatus = {
      configured: this.isConfigured(),
      enabled: r?.enabled === 1,
      running: false,
      endpoint: r?.endpoint ?? null,
      listenPort: r?.listen_port ?? 51820,
      overlayCidr: r?.overlay_cidr ?? '10.9.0.0/24',
      hubAddress: r?.hub_address ?? '10.9.0.1',
      publicKey: r?.public_key ?? null,
      runtimeError: null,
      peers: [],
    };
    if (!r || r.enabled !== 1) return base;
    try {
      base.running = await this.ifaceExists();
      base.peers = base.running ? await this.dumpPeers() : [];
    } catch (err) {
      base.runtimeError = (err as Error).message;
    }
    return base;
  }

  /** Persist enabled flag + (re)bring the interface up/down accordingly. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.db.prepare('UPDATE wg_hub SET enabled = ?, updated_at = ? WHERE id = 1').run(enabled ? 1 : 0, new Date().toISOString());
    if (enabled) await this.up(); else await this.down();
  }

  /** On process start: if the hub is enabled, try to bring it up. Failure is
   *  logged but never fatal — the app (and the LAN path) keeps running. */
  async startup(): Promise<void> {
    const r = this.row();
    if (!r || r.enabled !== 1) return;
    try { await this.up(); }
    catch (err) { log.warn(`WireGuard hub could not start: ${(err as Error).message}`); }
  }
}
