// Clipboard utility (v1.1.3). The important behaviour: over plain HTTP (no secure
// context) navigator.clipboard is unavailable, so copyText() MUST fall back to the
// hidden-textarea + execCommand path and still succeed — otherwise every Copy
// button silently no-ops for LAN installs. Also: a source guard proving no module
// calls navigator.clipboard directly (the whole point of the shared utility).
//   (runs under `node --experimental-transform-types --test`)
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyText, downloadText } from '../src/lib/clipboard.ts';

// Save/restore real globals (navigator is a getter-only global on Node 24; URL and
// Blob are real too) so stubbing one test never breaks the next.
const saved: Record<string, PropertyDescriptor | undefined> = {};
function setGlobal(key: string, value: unknown) {
  if (!(key in saved)) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [key, desc] of Object.entries(saved)) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

function stubDom(opts: { secure: boolean; clipboardWrite?: (t: string) => Promise<void>; execResult: boolean }) {
  let execCalled = false;
  setGlobal('window', { isSecureContext: opts.secure, getSelection: () => null });
  setGlobal('navigator', opts.clipboardWrite ? { clipboard: { writeText: opts.clipboardWrite } } : {});
  setGlobal('document', {
    createElement: () => ({ setAttribute() {}, style: {}, focus() {}, select() {}, setSelectionRange() {}, value: '' }),
    body: { appendChild() {}, removeChild() {} },
    getSelection: () => null,
    execCommand: () => { execCalled = true; return opts.execResult; },
  });
  return () => execCalled;
}

test('secure context: uses the async Clipboard API, not the fallback', async () => {
  let clip = '';
  const execCalled = stubDom({ secure: true, clipboardWrite: async (t) => { clip = t; }, execResult: false });
  const ok = await copyText('hello');
  assert.equal(ok, true);
  assert.equal(clip, 'hello');
  assert.equal(execCalled(), false, 'the execCommand fallback must NOT run when the clipboard API works');
});

test('plain HTTP (no clipboard API): FALLS BACK to execCommand and succeeds', async () => {
  const execCalled = stubDom({ secure: false, execResult: true });
  const ok = await copyText('over-http');
  assert.equal(ok, true, 'copy succeeds over HTTP via the fallback');
  assert.equal(execCalled(), true, 'the fallback path ran');
});

test('secure context but the clipboard write REJECTS: still falls back', async () => {
  const execCalled = stubDom({ secure: true, clipboardWrite: async () => { throw new Error('denied'); }, execResult: true });
  const ok = await copyText('x');
  assert.equal(ok, true);
  assert.equal(execCalled(), true, 'a rejected clipboard write falls through to the fallback');
});

test('total failure (no clipboard AND execCommand returns false) → false, so caller can offer Ctrl+C', async () => {
  const execCalled = stubDom({ secure: false, execResult: false });
  const ok = await copyText('x');
  assert.equal(ok, false);
  assert.equal(execCalled(), true);
});

test('downloadText builds a Blob object-URL link, clicks and revokes it (works over HTTP)', () => {
  let clicked = false, revoked = false;
  const a: Record<string, unknown> = { href: '', download: '', click() { clicked = true; }, remove() {} };
  setGlobal('document', { createElement: () => a, body: { appendChild() {}, removeChild() {} } });
  setGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => { revoked = true; } });
  setGlobal('Blob', class { constructor(_parts: unknown, _opts: unknown) { void _parts; void _opts; } });
  downloadText('recovery.txt', 'code1\ncode2');
  assert.equal(a.download, 'recovery.txt');
  assert.equal(a.href, 'blob:abc');
  assert.equal(clicked, true);
  assert.equal(revoked, true);
});

// The guard that makes this a "one shared utility" fix: no other module may call
// navigator.clipboard directly — they must route through copyText().
test('no navigator.clipboard call sites outside lib/clipboard.ts', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
  const allow = path.join('lib', 'clipboard.ts');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('navigator.clipboard') && !p.endsWith(allow)) {
        offenders.push(path.relative(srcRoot, p));
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], `direct navigator.clipboard call sites must route through copyText(): ${offenders.join(', ')}`);
});
