// P43.2 — router-side DNS enforcement (sim). Exact rule-set per scenario (local / over-WG /
// exemptions / both fail modes), the dnsMgmtGuard refusals, and the mgmt-never-matched assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnforcementPlan, validateEnforceInput, dnsMgmtGuard, enforcementIsMgmtSafe,
  DOH_ENDPOINTS, EXEMPT_LIST,
} from '../dist/netdns.js';

const MGMT = { mgmtIp: '192.168.88.1', mgmtInterface: 'ether1', mgmtPorts: ['ether1'], mgmtPort: 80, mgmtScheme: 'http' };
const localClosed = { resolverIp: '192.168.88.2', resolverNet: 'direct', lanInterfaces: ['bridge-lan'], wanInterfaces: ['ether-wan'], exemptions: [], failMode: 'closed', fallbackUpstream: '', blockDoh: false };

test('local resolver, fail-closed, no exemptions/DoH — exact object set (incl. WAN 53 drop)', () => {
  const p = buildEnforcementPlan(localClosed);
  assert.deepEqual(p.dns, { servers: '192.168.88.2', 'allow-remote-requests': 'yes' });
  assert.deepEqual(p.all.map((o) => o.body), [
    { chain: 'dstnat', 'in-interface': 'bridge-lan', protocol: 'udp', 'dst-port': '53', action: 'redirect', 'to-ports': '53', comment: 'RUBYMIK-DNS redirect-udp-bridge-lan' },
    { chain: 'dstnat', 'in-interface': 'bridge-lan', protocol: 'tcp', 'dst-port': '53', action: 'redirect', 'to-ports': '53', comment: 'RUBYMIK-DNS redirect-tcp-bridge-lan' },
    { chain: 'forward', 'in-interface': 'bridge-lan', protocol: 'tcp', 'dst-port': '853', action: 'drop', comment: 'RUBYMIK-DNS block-dot-bridge-lan' },
    { chain: 'input', 'in-interface': 'ether-wan', protocol: 'udp', 'dst-port': '53', action: 'drop', comment: 'RUBYMIK-DNS block-wan-dns-udp-ether-wan' },
    { chain: 'input', 'in-interface': 'ether-wan', protocol: 'tcp', 'dst-port': '53', action: 'drop', comment: 'RUBYMIK-DNS block-wan-dns-tcp-ether-wan' },
  ]);
});

test('OPEN-RESOLVER GUARD — a plan that sets allow-remote-requests ALWAYS drops :53 on WAN input', () => {
  for (const failMode of ['open', 'closed']) {
    const p = buildEnforcementPlan({ ...localClosed, failMode, fallbackUpstream: '1.1.1.1', wanInterfaces: ['ether-wan', 'pppoe-out'] });
    assert.equal(p.dns['allow-remote-requests'], 'yes');
    for (const wan of ['ether-wan', 'pppoe-out']) for (const proto of ['udp', 'tcp']) {
      assert.ok(p.wanDnsDrop.some((r) => r.body.chain === 'input' && r.body['in-interface'] === wan && r.body.protocol === proto && r.body['dst-port'] === '53' && r.body.action === 'drop'),
        `missing WAN 53 input drop for ${proto} on ${wan}`);
    }
  }
});

test('fail-open vs fail-closed — the diff is /ip/dns servers (fallback upstream)', () => {
  const closed = buildEnforcementPlan(localClosed);
  const open = buildEnforcementPlan({ ...localClosed, failMode: 'open', fallbackUpstream: '1.1.1.1' });
  assert.equal(closed.dns.servers, '192.168.88.2');
  assert.equal(open.dns.servers, '192.168.88.2,1.1.1.1');
  // the firewall object set is otherwise identical
  assert.deepEqual(closed.all.map((o) => o.body.comment), open.all.map((o) => o.body.comment));
});

test('exemptions — redirect/blocks gain src-address-list=!exempt + an address-list entry', () => {
  const p = buildEnforcementPlan({ ...localClosed, exemptions: ['192.168.88.50'] });
  assert.ok(p.redirects.every((r) => r.body['src-address-list'] === `!${EXEMPT_LIST}`));
  assert.deepEqual(p.lists.map((l) => l.body), [{ list: EXEMPT_LIST, address: '192.168.88.50', comment: 'RUBYMIK-DNS exempt' }]);
});

test('over-WG (tunnel resolver) + DoH block — resolver is the tunnel IP; DoH list + 443 drop added', () => {
  const p = buildEnforcementPlan({ ...localClosed, resolverIp: '10.7.0.1', resolverNet: 'tunnel', blockDoh: true });
  assert.equal(p.dns.servers, '10.7.0.1'); // reached over the router's rmik-wg (the router's own upstream)
  assert.ok(p.filters.some((f) => f.body['dst-port'] === '443' && f.body['dst-address-list'] === 'RUBYMIK-DNS-doh' && f.body.action === 'drop'));
  assert.equal(p.lists.filter((l) => l.body.list === 'RUBYMIK-DNS-doh').length, DOH_ENDPOINTS.length);
});

test('dnsMgmtGuard — refuses empty interfaces, the mgmt interface, and the WG tunnel-back', () => {
  assert.equal(dnsMgmtGuard(MGMT, localClosed), null); // bridge-lan is fine
  assert.match(dnsMgmtGuard(MGMT, { ...localClosed, lanInterfaces: [] }) ?? '', /empty in-interface|EVERY interface/i);
  assert.match(dnsMgmtGuard(MGMT, { ...localClosed, lanInterfaces: ['ether1'] }) ?? '', /management path/i); // ether1 = mgmt
  assert.match(dnsMgmtGuard(MGMT, { ...localClosed, lanInterfaces: ['rmik-wg'] }) ?? '', /tunnel-back|management/i);
});

test('enforcementIsMgmtSafe — clean LAN passes; a mgmt-matching plan is flagged', () => {
  assert.equal(enforcementIsMgmtSafe(buildEnforcementPlan(localClosed), MGMT).safe, true);
  const bad = enforcementIsMgmtSafe(buildEnforcementPlan({ ...localClosed, lanInterfaces: ['ether1'] }), MGMT);
  assert.equal(bad.safe, false);
  assert.ok(bad.problems.some((p) => /mgmt path/.test(p)));
});

test('validateEnforceInput — resolver IP, empty LAN, bad exemption, fail-open needs fallback', () => {
  assert.deepEqual(validateEnforceInput(localClosed), []);
  assert.ok(validateEnforceInput({ ...localClosed, resolverIp: 'nope' }).some((e) => /valid IPv4/.test(e)));
  assert.ok(validateEnforceInput({ ...localClosed, lanInterfaces: [] }).some((e) => /at least one LAN/i.test(e)));
  assert.ok(validateEnforceInput({ ...localClosed, wanInterfaces: [] }).some((e) => /open resolver/i.test(e)));
  assert.ok(validateEnforceInput({ ...localClosed, exemptions: ['1.2.3.999'] }).some((e) => /not a valid IPv4/.test(e)));
  assert.ok(validateEnforceInput({ ...localClosed, failMode: 'open', fallbackUpstream: '' }).some((e) => /fallback upstream/i.test(e)));
});
