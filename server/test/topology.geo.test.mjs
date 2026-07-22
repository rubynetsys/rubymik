// P33 geographic map tests: site-coordinate validation (range + both-or-neither)
// and the per-site worst-status rollup (managed nodes only; discovered nodes
// never colour a site; geographic columns are stitched back on). No network.
//   node --test test/topology.geo.test.mjs   (after `npm run build`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteInput } from '../dist/routes/sites.js';
import { rollupSites } from '../dist/topology.js';

// ---------------- coordinate validation ----------------

test('parseSiteInput accepts valid coordinates and stores them as numbers', () => {
  const r = parseSiteInput({ name: 'HQ', latitude: -33.9249, longitude: 18.4241 });
  assert.equal(typeof r, 'object');
  assert.equal(r.latitude, -33.9249);
  assert.equal(r.longitude, 18.4241);
});

test('parseSiteInput allows a site with no coordinates (both null)', () => {
  const r = parseSiteInput({ name: 'HQ' });
  assert.equal(r.latitude, null);
  assert.equal(r.longitude, null);
});

test('parseSiteInput rejects out-of-range and half-set coordinates', () => {
  assert.match(parseSiteInput({ name: 'HQ', latitude: 120, longitude: 0 }), /Latitude/);
  assert.match(parseSiteInput({ name: 'HQ', latitude: 0, longitude: 999 }), /Longitude/);
  assert.match(parseSiteInput({ name: 'HQ', latitude: -33.9, longitude: '' }), /both/i);
  assert.match(parseSiteInput({ name: 'HQ', longitude: 18.4 }), /both/i);
});

test('parseSiteInput still requires a name', () => {
  assert.match(parseSiteInput({ latitude: 0, longitude: 0 }), /name is required/i);
});

// ---------------- per-site status rollup ----------------

const site = (id, name) => ({ id, name, latitude: 1, longitude: 2 });
const mnode = (siteId, status) => ({ key: `d${Math.random()}`, kind: 'managed', name: 'r', siteId, status });

test('rollupSites folds managed nodes into worst-status + counts, keeping geo columns', () => {
  const nodes = [
    mnode(1, 'up'), mnode(1, 'warning'), mnode(1, 'up'),   // site 1 → worst = warning
    mnode(2, 'up'), mnode(2, 'down'),                       // site 2 → worst = down
    mnode(3, 'up'),                                         // site 3 → up
    { key: 'x', kind: 'discovered', name: 'n', siteId: 2, status: 'down' }, // discovered → ignored
  ];
  const out = rollupSites(nodes, [site(1, 'A'), site(2, 'B'), site(3, 'C'), site(4, 'Empty')]);
  const by = Object.fromEntries(out.map((s) => [s.id, s]));

  assert.equal(by[1].status, 'warning');
  assert.deepEqual(by[1].counts, { total: 3, up: 2, warning: 1, down: 0, pending: 0 });
  assert.equal(by[2].status, 'down');           // down outranks up (and the discovered node didn't matter)
  assert.equal(by[2].counts.total, 2);
  assert.equal(by[3].status, 'up');
  assert.equal(by[4].status, 'pending');        // a site with no managed devices
  assert.deepEqual(by[4].counts, { total: 0, up: 0, warning: 0, down: 0, pending: 0 });
  // geographic columns survive the fold
  assert.equal(by[1].latitude, 1); assert.equal(by[1].longitude, 2);
});

test('rollupSites: down outranks warning outranks up', () => {
  const out = rollupSites([mnode(1, 'up'), mnode(1, 'down'), mnode(1, 'warning')], [site(1, 'A')]);
  assert.equal(out[0].status, 'down');
});
