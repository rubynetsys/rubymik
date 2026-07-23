// Hub capability pre-check + generated setup compose (P45).
//   node --test test/hubcapability.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNetAdmin, decideCapability, generateHubCompose, hubComposeCli } from '../dist/hubcapability.js';

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

test('generateHubCompose: valid YAML shape, and reflects the image tag + UDP port', () => {
  const yaml = generateHubCompose({ version: '1.1.2', listenPort: 51820 });
  assertYamlWellFormed(yaml);
  // the wizard's whole point — the one irreducible server-side step is present:
  assert.match(yaml, /cap_add:/);
  assert.match(yaml, /- NET_ADMIN/);
  assert.match(yaml, /user: "0:0"/, 'root — NET_ADMIN is only effective for root');
  assert.match(yaml, /\/dev\/net\/tun/);
  // their actual current image tag (not :latest) as the default:
  assert.ok(yaml.includes('ghcr.io/rubynetsys/rubymik:1.1.2'), 'defaults to the running version tag');
  assert.ok(yaml.includes('${RUBYMIK_IMAGE:-'), 'a custom RUBYMIK_IMAGE still wins');
  // the UDP port to publish:
  assert.ok(yaml.includes('51820:51820/udp'), 'publishes the hub UDP port');
  // complete service + volumes so it can be pasted whole:
  assert.match(yaml, /^services:/m);
  assert.match(yaml, /^  rubymik:/m);
  assert.match(yaml, /^volumes:/m);
  assert.match(yaml, /rubymik-data:/);
});

test('generateHubCompose: the UDP port follows the configured listen port', () => {
  const yaml = generateHubCompose({ version: '2.0.0', listenPort: 51999 });
  assert.ok(yaml.includes('51999:51999/udp'), 'a non-default listen port is reflected');
  assert.ok(yaml.includes('ghcr.io/rubynetsys/rubymik:2.0.0'));
  assert.ok(!yaml.includes('51820'), 'no stale default port leaks in');
});

test('hubComposeCli: the two-file override command', () => {
  assert.equal(hubComposeCli(), 'docker compose -f docker-compose.yml -f docker-compose.wireguard.yml up -d --build');
});
