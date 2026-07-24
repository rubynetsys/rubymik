// Hub capability pre-check + generated setup compose (P45).
//   node --test test/hubcapability.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNetAdmin, decideCapability, generateHubCompose, hubComposeCli, parseHostPort } from '../dist/hubcapability.js';

// ---- CAP_NET_ADMIN (bit 12) parse from a /proc/self/status CapEff hex mask ----
test('hasNetAdmin: bit 12 of the CapEff mask', () => {
  assert.equal(hasNetAdmin('0000000000001000'), true, 'exactly bit 12 (0x1000)');
  assert.equal(hasNetAdmin('0000003fffffffff'), true, 'root/all-caps mask has it');
  assert.equal(hasNetAdmin('0x1000'), true, '0x prefix tolerated');
  assert.equal(hasNetAdmin('00000000a80425fb'), false, "docker default caps do NOT include NET_ADMIN");
  assert.equal(hasNetAdmin('0000000000000fff'), false, 'bits 0-11 only → no NET_ADMIN');
  assert.equal(hasNetAdmin('0000000000000000'), false, 'empty (non-root node user) → no');
  assert.equal(hasNetAdmin('not-hex'), false, 'garbage → false, never throws');
  assert.equal(hasNetAdmin(''), false, 'empty string → false');
});

// ---- decideCapability: the verdict + the FIRST-missing-piece reason ----
test('decideCapability: capable when NET_ADMIN + wg tool + wg kernel', () => {
  const c = decideCapability({ netAdmin: true, wgTool: true, wgKernel: true });
  assert.equal(c.capable, true);
  assert.equal(c.netAdmin, true);
  assert.equal(c.wireguard, true);
  assert.match(c.reason, /Ready/i);
});

test('decideCapability: NOT capable — missing NET_ADMIN is the primary, honest reason', () => {
  const c = decideCapability({ netAdmin: false, wgTool: true, wgKernel: null });
  assert.equal(c.capable, false);
  assert.equal(c.netAdmin, false);
  assert.match(c.reason, /NET_ADMIN/);
  assert.match(c.reason, /Docker's security/i, "names it as Docker's boundary, not RubyMIK's");
});

test('decideCapability: NET_ADMIN present but tool / kernel missing → specific reasons', () => {
  const noTool = decideCapability({ netAdmin: true, wgTool: false, wgKernel: null });
  assert.equal(noTool.capable, false);
  assert.match(noTool.reason, /wireguard-tools|`wg`/i);

  const noKernel = decideCapability({ netAdmin: true, wgTool: true, wgKernel: false });
  assert.equal(noKernel.capable, false);
  assert.equal(noKernel.wireguard, false);
  assert.match(noKernel.reason, /kernel/i);
});

// ---- generated Portainer compose: well-formed YAML + reflects THIS install ----
/** Structural YAML validity (dep-free): spaces-only indentation, in even steps. */
function assertYamlWellFormed(text) {
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    assert.ok(!line.includes('\t'), `line ${i + 1} must not contain a TAB (YAML indentation is spaces)`);
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    assert.equal(indent % 2, 0, `line ${i + 1} indent (${indent}) must be a multiple of 2: "${line}"`);
  }
}

// The v1.1.4 bug: the generator hardcoded 8080 and always added an 8081 published
// port. It must instead reproduce the DETECTED host port and publish nothing extra.
const CFG = { version: '1.1.4', mainHostPort: 8090, offhost: true, listenPort: 51820 };

test('generateHubCompose: reproduces the detected host port (8090), never assumes 8080, never adds 8081', () => {
  const yaml = generateHubCompose(CFG);
  assertYamlWellFormed(yaml);
  // Ray's bug: he runs on 8090 — reproduce it exactly, never a wrong 8080.
  assert.ok(yaml.includes('"8090:8080"'), 'the detected host port is reproduced');
  assert.ok(!/^\s+- "8080:8080"/m.test(yaml), 'NO hardcoded 8080 published port');
  // the 8081 webfig port must NOT be an ACTIVE published port (only an inert comment).
  assert.ok(!/^\s+- "8081:8081"/m.test(yaml), 'NO silently-added 8081 published port');
  assert.match(yaml, /# - "8081:8081"/, 'WebFig is an opt-in commented hint, not published');
  // the WG additions + one new UDP port:
  assert.match(yaml, /- NET_ADMIN/); assert.match(yaml, /user: "0:0"/); assert.match(yaml, /\/dev\/net\/tun/);
  assert.ok(yaml.includes('"51820:51820/udp"'), 'the one new published port is the WG UDP port');
  // image tag + override, complete service + volumes:
  assert.ok(yaml.includes('ghcr.io/rubynetsys/rubymik:1.1.4') && yaml.includes('${RUBYMIK_IMAGE:-'));
  assert.match(yaml, /^services:/m); assert.match(yaml, /^  rubymik:/m); assert.match(yaml, /^volumes:/m);
});

// THE test Ray asked for: generated == running PLUS only the WG lines. Nothing else.
test('generateHubCompose: diff vs the running config is EXACTLY the WireGuard lines (ports/volumes/env identical)', () => {
  const running = generateHubCompose(CFG, false).split('\n');
  const withWg = generateHubCompose(CFG, true).split('\n');
  const added = withWg.filter((l) => !running.includes(l));
  const removed = running.filter((l) => !withWg.includes(l));
  assert.deepEqual(removed, [], 'the WG file removes/changes NOTHING from the running config');
  assert.deepEqual(added, [
    '    user: "0:0"                     # WG: NET_ADMIN is only effective for root',
    '    cap_add:',
    '      - NET_ADMIN                   # WG: create/manage the WireGuard interface',
    '    devices:',
    '      - /dev/net/tun:/dev/net/tun   # WG: portability across kernels',
    '    sysctls:',
    '      - net.ipv4.ip_forward=1       # WG',
    '      - "51820:51820/udp"   # WG: routers dial this inbound',
  ], 'the ONLY additions are the WG service lines + the UDP port');
  // sanity: the shared (unchanged) lines include the reproduced port, env and volumes.
  assert.ok(running.includes('      - "8090:8080"'));
  assert.ok(running.some((l) => l.includes('RUBYMIK_BACKUP_KEY')));
  assert.ok(running.includes('      - rubymik-data:/data'));
  assert.ok(running.includes('      - rubymik-offhost:/offhost'));
});

test('generateHubCompose: undetectable host port → a "set your host port" comment, never a wrong 8080', () => {
  const yaml = generateHubCompose({ ...CFG, mainHostPort: null });
  assert.match(yaml, /set your host port here/i, 'tells the user to set it');
  assert.ok(!/^\s+- "\d+:8080"/m.test(yaml), 'NO active main-port line (no wrong default guessed)');
  assert.ok(!/^\s+- "8080:8080"/m.test(yaml), 'specifically no hardcoded 8080');
});

test('generateHubCompose: /offhost appears only when it is actually mounted', () => {
  assert.ok(generateHubCompose({ ...CFG, offhost: true }).includes('rubymik-offhost'));
  assert.ok(!generateHubCompose({ ...CFG, offhost: false }).includes('offhost'), 'not added when not mounted');
});

test('parseHostPort: derives the host publish port from the request headers', () => {
  assert.equal(parseHostPort({ host: '192.168.1.5:8090' }), 8090, 'the LAN case Ray hit');
  assert.equal(parseHostPort({ host: 'rubymik.example.com' }), null, 'no explicit port → null (→ comment, not a guess)');
  assert.equal(parseHostPort({ host: 'host:8080', forwardedPort: '8443' }), 8443, 'a proxy X-Forwarded-Port wins');
  assert.equal(parseHostPort({ host: 'host:8080', forwardedHost: 'edge:9000' }), 9000, 'X-Forwarded-Host port beats Host');
  assert.equal(parseHostPort({ host: '[::1]:8080' }), 8080, 'IPv6 host:port');
  assert.equal(parseHostPort({ host: 'host:99999' }), null, 'out-of-range port → null');
  assert.equal(parseHostPort({ forwardedPort: '8090, 8091' }), 8090, 'first value of a proxy list');
  assert.equal(parseHostPort({}), null, 'nothing → null');
});

test('hubComposeCli: the two-file override command', () => {
  assert.equal(hubComposeCli(), 'docker compose -f docker-compose.yml -f docker-compose.wireguard.yml up -d --build');
});
