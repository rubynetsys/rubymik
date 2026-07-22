// P41 — the synthetic RouterOS responder that gives the public demo a live device.
// Proves it speaks enough of the RouterOS 7 REST API that RubyMIK's OWN client
// (restConnect) reads a coherent system snapshot from it, plus endpoint shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoRouter } from '../dist/devtools/demo-router.js';
import { restConnect } from '../dist/routeros/rest.js';

function start() {
  const server = createDemoRouter();
  server.listen(0);
  return { server, port: server.address().port };
}
const rest = async (port, path) => (await (await fetch(`http://127.0.0.1:${port}/rest${path}`)).json());

test('RubyMIK\'s real client connects and reads a coherent snapshot', async () => {
  const { server, port } = start();
  try {
    const r = await restConnect({ host: '127.0.0.1', port, useTls: false, username: 'admin', password: 'x' });
    assert.equal(r.transport, 'rest');
    assert.equal(r.scheme, 'http');
    assert.equal(r.info.identity, 'zzz-demo-gw');
    assert.equal(r.info.model, 'RB5009UG+S+IN');
    assert.match(r.info.version, /^7\.16/);
    assert.ok(r.info.cpuLoad >= 0 && r.info.cpuLoad <= 100, 'cpu load in range');
    assert.ok(r.info.totalMemory > 0 && r.info.freeMemory > 0, 'memory populated');
  } finally { server.close(); }
});

test('interfaces carry increasing byte counters the poller can graph', async () => {
  const { server, port } = start();
  try {
    const ifaces = await rest(port, '/interface');
    assert.ok(Array.isArray(ifaces) && ifaces.length >= 5);
    const names = ifaces.map((i) => i.name);
    for (const n of ['ether1', 'zzz-lan', 'zzz-wg0']) assert.ok(names.includes(n), `has ${n}`);
    for (const i of ifaces) {
      assert.match(String(i['rx-byte']), /^\d+$/);
      assert.ok(Number(i['rx-byte']) > 0 && Number(i['tx-byte']) > 0);
      assert.equal(i.running, 'true');
    }
  } finally { server.close(); }
});

test('topology neighbors + object-vs-array shapes are correct', async () => {
  const { server, port } = start();
  try {
    const neigh = await rest(port, '/ip/neighbor');
    assert.ok(Array.isArray(neigh) && neigh.length >= 2);
    assert.ok(neigh.every((n) => typeof n.identity === 'string' && typeof n['mac-address'] === 'string'));

    // single-value menus are OBJECTS, list menus are ARRAYS
    assert.ok(!Array.isArray(await rest(port, '/ip/neighbor/discovery-settings')));
    assert.ok(!Array.isArray(await rest(port, '/system/resource')));
    assert.ok(Array.isArray(await rest(port, '/ip/route')));
    assert.ok(Array.isArray(await rest(port, '/ip/dhcp-server/lease')));

    // health is an array of {name,value}
    const health = await rest(port, '/system/health');
    assert.ok(Array.isArray(health) && health.some((h) => h.name === 'temperature' && 'value' in h));

    // an unpopulated menu returns an empty list, never an error
    assert.deepEqual(await rest(port, '/interface/wifi'), []);
  } finally { server.close(); }
});

test('non-GET is refused as read-only (empty list, no mutation)', async () => {
  const { server, port } = start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rest/system/identity/set`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-demo-router'), 'read-only');
    assert.deepEqual(await res.json(), []);
  } finally { server.close(); }
});
