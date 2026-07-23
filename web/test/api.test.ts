// api client — error surfacing (v1.1.1). A non-2xx response must surface a
// field-level reason from EITHER convention: a single `error` string OR an
// `errors: string[]` list. Before the fix, an `{errors:[...]}` body (validate /
// generate / apply) showed a bare "Request failed (HTTP 400)" and swallowed the
// real reason — that's the wizard's silent-400.
//   (runs under `node --experimental-transform-types --test`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

test('errors[] array is surfaced as the message (the swallowed-400)', async () => {
  stubFetch(400, { ok: false, errors: ['Remote provisioning needs the WireGuard hub. Set up Remote Access first.'] });
  await assert.rejects(
    () => api.post('/api/provision/generate', {}),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).status, 400);
      assert.match((e as Error).message, /WireGuard hub/);
      assert.doesNotMatch((e as Error).message, /Request failed \(HTTP/);
      return true;
    },
  );
});

test('multiple errors are joined with "; "', async () => {
  stubFetch(400, { ok: false, errors: ['DHCP pool start is outside the LAN subnet.', 'LAN prefix length must be between /8 and /30.'] });
  await assert.rejects(() => api.post('/x', {}), (e: unknown) =>
    (e as Error).message === 'DHCP pool start is outside the LAN subnet.; LAN prefix length must be between /8 and /30.');
});

test('a single `error` string still wins (unchanged behaviour)', async () => {
  stubFetch(400, { error: 'Live-apply (Mode B) is LAN-only.' });
  await assert.rejects(() => api.post('/x', {}), (e: unknown) => (e as Error).message === 'Live-apply (Mode B) is LAN-only.');
});

test('falls back to the generic message when the body carries neither', async () => {
  stubFetch(500, { unrelated: true });
  await assert.rejects(() => api.post('/x', {}), (e: unknown) => /Request failed \(HTTP 500\)/.test((e as Error).message));
});

test('non-string entries in errors[] are ignored, not rendered', async () => {
  stubFetch(400, { errors: [42, { a: 1 }, 'the only real reason'] });
  await assert.rejects(() => api.post('/x', {}), (e: unknown) => (e as Error).message === 'the only real reason');
});
