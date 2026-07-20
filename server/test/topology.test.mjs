// Unit tests for the pure topology builder — run with:
//   node --test test/   (after `npm run build`; tests import from dist/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../dist/topology.js';

const status = (over = {}) => ({
  state: 'up', last_error: null, cpu_load: 5, mem_total: 100, mem_free: 60,
  identity: null, model: 'RB5009', board_name: null, version: '7.20',
  if_macs: [], ...over,
});

const dev = (id, name, host, over = {}) => ({
  id, name, host, siteId: 1, siteName: 'HQ', status: status(over),
});

const nb = (deviceId, over = {}) => ({
  deviceId, seenOn: null, mac: null, identity: null, platform: null, board: null,
  version: null, address: null, remoteInterface: null, discoveredBy: 'mndp', ...over,
});

test('bidirectional sighting dedupes to ONE edge with both interfaces', () => {
  const devices = [
    dev(1, 'Core', '10.0.0.1', { if_macs: ['aa:aa:aa:aa:aa:01'] }),
    dev(2, 'Edge', '10.0.0.2', { if_macs: ['bb:bb:bb:bb:bb:02'] }),
  ];
  const neighbors = [
    // Core sees Edge on ether5 (matched by Edge's MAC)…
    nb(1, { seenOn: 'ether5', mac: 'bb:bb:bb:bb:bb:02', identity: 'Edge' }),
    // …and Edge sees Core on ether1 (matched by Core's MAC).
    nb(2, { seenOn: 'ether1', mac: 'aa:aa:aa:aa:aa:01', identity: 'Core' }),
  ];
  const t = buildTopology(devices, neighbors, []);
  assert.equal(t.edges.length, 1, 'A↔B must be ONE edge, not two');
  const e = t.edges[0];
  assert.equal(e.ifaces['device:1'], 'ether5');
  assert.equal(e.ifaces['device:2'], 'ether1');
  assert.equal(t.nodes.filter((n) => n.kind === 'managed').length, 2);
  assert.equal(t.nodes.filter((n) => n.kind === 'discovered').length, 0);
});

test('unmanaged neighbor seen by two managed devices is one node, two edges', () => {
  const devices = [dev(1, 'GW-A', '10.0.0.1'), dev(2, 'GW-B', '10.0.0.2')];
  const sw = { mac: 'cc:cc:cc:cc:cc:03', identity: 'office-switch', platform: 'MikroTik' };
  const neighbors = [nb(1, { ...sw, seenOn: 'ether2' }), nb(2, { ...sw, seenOn: 'ether7' })];
  const t = buildTopology(devices, neighbors, []);
  const discovered = t.nodes.filter((n) => n.kind === 'discovered');
  assert.equal(discovered.length, 1, 'same MAC must merge to one node');
  assert.equal(discovered[0].seenBy.length, 2);
  assert.equal(t.edges.length, 2, 'each managed device keeps its own link to it');
});

test('a discovered node becomes managed once a device with that host is added', () => {
  const neighbor = nb(1, { identity: 'branch-gw', address: '10.9.9.9', seenOn: 'wan1' });
  const before = buildTopology([dev(1, 'Core', '10.0.0.1')], [neighbor], []);
  assert.equal(before.nodes.filter((n) => n.kind === 'discovered').length, 1);

  const after = buildTopology(
    [dev(1, 'Core', '10.0.0.1'), dev(9, 'Branch GW', '10.9.9.9')],
    [neighbor],
    [],
  );
  assert.equal(after.nodes.filter((n) => n.kind === 'discovered').length, 0, 'no longer "discovered"');
  const managedKeys = after.nodes.filter((n) => n.kind === 'managed').map((n) => n.key);
  assert.ok(managedKeys.includes('device:9'));
  assert.equal(after.edges.length, 1);
  assert.deepEqual([after.edges[0].source, after.edges[0].target].sort(), ['device:1', 'device:9']);
});

test('self-sightings are never drawn; identity alone never merges nodes', () => {
  const devices = [dev(1, 'GW', '10.0.0.1', { if_macs: ['aa:aa:aa:aa:aa:01'], identity: 'MikroTik' })];
  const neighbors = [
    // a device reporting its own MAC (loop/reflection) must not self-edge
    nb(1, { mac: 'aa:aa:aa:aa:aa:01', seenOn: 'bridge1' }),
    // default-named identity must NOT match the managed device
    nb(1, { identity: 'MikroTik', address: '192.168.88.2', seenOn: 'ether3' }),
  ];
  const t = buildTopology(devices, neighbors, []);
  assert.equal(t.edges.length, 1, 'only the genuine neighbor edge remains');
  assert.equal(t.nodes.filter((n) => n.kind === 'discovered').length, 1);
});

test('discovery notes: restricted and disabled surface honestly', () => {
  const t = buildTopology(
    [dev(1, 'GW', '10.0.0.1'), dev(2, 'AP', '10.0.0.2')],
    [],
    [
      { deviceId: 1, protocol: 'cdp,lldp,mndp', interfaceList: 'static' },
      { deviceId: 2, protocol: 'cdp,lldp,mndp', interfaceList: 'none' },
    ],
  );
  assert.equal(t.notes.find((n) => n.deviceId === 1).level, 'restricted');
  assert.equal(t.notes.find((n) => n.deviceId === 2).level, 'disabled');
});
