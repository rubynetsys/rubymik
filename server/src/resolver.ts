// P43 — DNS-filter resolver control (I/O). Writes the Blocky config to the shared volume,
// restarts the resolver container via the Docker Engine API (over the socket that only a
// filtering deployment mounts), and VERIFIES the resolver answers + blocks a probe domain after
// reload. "Save & apply" uses reloadAndVerify() and only reports success once the probe passes.
import http from 'node:http';
import dgram from 'node:dgram';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildBlockyConfig, probeBlockedDomain, DEFAULT_SETTINGS, type ResolverSettings } from './dnsfilter.js';

/** Boot: if the shared config doesn't exist yet, write a default one so the resolver container
 *  (restart: unless-stopped) has something to start from. Best-effort — never throws at boot. */
export function ensureResolverConfig(configPath: string): void {
  try {
    if (existsSync(configPath)) return;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, buildBlockyConfig(DEFAULT_SETTINGS), 'utf8');
  } catch { /* the resolver will keep restarting; the UI surfaces the missing config */ }
}

/** POST /containers/<name>/restart to the Docker Engine API over the unix socket (no deps). */
function dockerRestart(sockPath: string, name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: sockPath, method: 'POST', path: `/containers/${encodeURIComponent(name)}/restart?t=5`, timeout: 25000 },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
    req.end();
  });
}

/** One DNS A-query over UDP; resolves to the answer A-record IPs ([] when none). No deps. */
export function dnsQuery(host: string, port: number, name: string, timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const header = Buffer.from([0x4b, 0x3d, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    const labels: number[] = [];
    for (const part of name.split('.')) { labels.push(part.length); for (const b of Buffer.from(part)) labels.push(b); }
    const packet = Buffer.concat([header, Buffer.from([...labels, 0, 0, 1, 0, 1])]);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('DNS query timeout')); }, timeoutMs);
    sock.on('message', (msg) => {
      clearTimeout(timer); sock.close();
      try {
        const anCount = msg.readUInt16BE(6);
        let i = 12; while (msg[i] !== 0) i += 1 + msg[i]!; i += 5; // skip the question section
        const ips: string[] = [];
        for (let a = 0; a < anCount; a++) {
          i += 2; const type = msg.readUInt16BE(i); i += 8;
          const rdlen = msg.readUInt16BE(i); i += 2;
          if (type === 1 && rdlen === 4) ips.push(`${msg[i]}.${msg[i + 1]}.${msg[i + 2]}.${msg[i + 3]}`);
          i += rdlen;
        }
        resolve(ips);
      } catch (e) { reject(e as Error); }
    });
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(packet, port, host);
  });
}

/** outageMs = restart→answering duration. For a fail-CLOSED site this is exactly how long its
 *  clients lose DNS during a filter update, so we measure and surface it honestly. null if the
 *  resolver never came back (the outage isn't bounded — a worse signal than any number). */
export interface ReloadResult { ok: boolean; detail: string; outageMs: number | null; }

/**
 * Write the config → restart the resolver → wait for it to answer → verify it BLOCKS the probe
 * domain (the new rules took) and is up (fail-open sanity). Only ok:true once the probe passes.
 * Measures the restart→answering window (the fail-closed DNS-outage duration).
 */
export async function reloadAndVerify(opts: {
  configPath: string; dockerSock: string; container: string;
  probeHost: string; probePort: number; settings: ResolverSettings; now?: () => number;
}): Promise<ReloadResult> {
  const now = opts.now ?? Date.now;
  await writeFile(opts.configPath, buildBlockyConfig(opts.settings), 'utf8');

  const t0 = now();
  let code: number;
  try { code = await dockerRestart(opts.dockerSock, opts.container); }
  catch (e) { return { ok: false, outageMs: null, detail: `Could not restart the resolver (${(e as Error).message}). Is the filtering profile deployed?` }; }
  if (code >= 300) return { ok: false, outageMs: null, detail: `The resolver restart was rejected (Docker API ${code}).` };

  // wait for it to come back up (answering any control query), timing the outage window
  let outageMs: number | null = null;
  for (let i = 0; i < 60; i++) {
    try { await dnsQuery(opts.probeHost, opts.probePort, 'cloudflare.com'); outageMs = now() - t0; break; } catch { await sleep(500); }
  }
  if (outageMs === null) return { ok: false, outageMs: null, detail: 'The resolver did not answer within 30s after reload — NOT reporting the change as applied. Check the resolver logs.' };
  const secs = Math.max(1, Math.round(outageMs / 1000));

  const blockDomain = probeBlockedDomain(opts.settings);
  if (!blockDomain) return { ok: true, outageMs, detail: `Applied — the resolver is up and answering (no reliable block-probe for this rule set). It was unreachable for ~${secs}s during the reload.` };
  let ips: string[];
  try { ips = await dnsQuery(opts.probeHost, opts.probePort, blockDomain); }
  catch (e) { return { ok: false, outageMs, detail: `Reloaded, but the block-probe query failed: ${(e as Error).message}.` }; }
  const blocked = ips.length === 0 || ips.every((x) => x === '0.0.0.0' || x === '::');
  if (!blocked) return { ok: false, outageMs, detail: `Reloaded, but "${blockDomain}" is NOT being blocked (got ${ips.join(', ')}) — the rules may not have taken.` };
  return { ok: true, outageMs, detail: `Applied and verified — blocking "${blockDomain}". The resolver was unreachable for ~${secs}s during the reload (fail-closed sites lose DNS for that window).` };
}
