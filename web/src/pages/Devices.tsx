import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, CheckCircle2, ChevronDown, Cpu, HardDrive, Loader2, MemoryStick,
  Pencil, Plus, RefreshCw, Router as RouterIcon, StickyNote, Trash2, X, XCircle,
} from 'lucide-react';
import { api } from '../api';
import { fmtBytes, type Device, type RouterSystemInfo, type Site, type TestResult } from '../types';

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [modal, setModal] = useState<{ mode: 'add' } | { mode: 'edit'; device: Device } | null>(null);
  const [tests, setTests] = useState<Record<number, { state: 'busy' } | { state: 'ok'; result: TestResult } | { state: 'fail'; error: string }>>({});

  const reload = useCallback(() => {
    api.get<Device[]>('/api/devices').then(setDevices).catch(() => {});
    api.get<Site[]>('/api/sites').then(setSites).catch(() => {});
  }, []);

  useEffect(() => reload(), [reload]);

  async function testDevice(id: number) {
    setTests((t) => ({ ...t, [id]: { state: 'busy' } }));
    try {
      const result = await api.post<TestResult>(`/api/devices/${id}/test`);
      setTests((t) => ({ ...t, [id]: { state: 'ok', result } }));
      reload();
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { state: 'fail', error: (err as Error).message } }));
    }
  }

  async function removeDevice(id: number) {
    if (!confirm('Remove this device? Its stored credentials will be deleted.')) return;
    await api.del(`/api/devices/${id}`).catch(() => {});
    reload();
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-fg-strong">Devices</h1>
          <p className="mt-1 text-sm text-fg-dim">MikroTik devices RubyMIK polls on this network.</p>
        </div>
        <button
          onClick={() => setModal({ mode: 'add' })}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-inverse transition hover:bg-accent-hover"
        >
          <Plus className="h-4 w-4" /> Add device
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {devices.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border-strong bg-surface/60 p-10 text-center text-sm text-fg-dim">
            No devices yet — add your first MikroTik with its IP and a RouterOS login.
          </div>
        )}
        {devices.map((d) => {
          const t = tests[d.id];
          return (
            <div key={d.id} className="rounded-2xl border border-border bg-surface shadow-sm">
              <div className="flex items-center gap-4 px-5 py-4">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-subtle">
                  <RouterIcon className="h-5 w-5 text-accent" />
                  <span
                    title={d.status === 'up' ? 'Up' : d.status === 'down' ? 'Down' : 'Not polled yet'}
                    className={`absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface ${
                      d.status === 'up' ? 'bg-success-strong' : d.status === 'down' ? 'bg-danger' : 'bg-border-strong'
                    }`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={`/devices/${d.id}`} className="truncate font-semibold text-fg-strong hover:text-accent-text">
                      {d.name}
                    </Link>
                    {d.notes && (
                      <span title={d.notes}><StickyNote className="h-3.5 w-3.5 shrink-0 text-fg-faint" /></span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 truncate text-xs text-fg-dim">
                    <span>
                      {d.host}{d.port ? `:${d.port}` : ''} · REST{' '}
                      {d.useTls === null ? '(auto)' : d.useTls ? '(https)' : '(http)'}
                    </span>
                    {d.siteName && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-app px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
                        <Building2 className="h-3 w-3" /> {d.siteName}
                      </span>
                    )}
                  </div>
                </div>
                {t?.state === 'ok' && <CheckCircle2 className="h-5 w-5 text-success-strong" />}
                {t?.state === 'fail' && <XCircle className="h-5 w-5 text-danger" />}
                <button
                  onClick={() => void testDevice(d.id)}
                  disabled={t?.state === 'busy'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-50"
                >
                  {t?.state === 'busy'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RefreshCw className="h-3.5 w-3.5" />}
                  Test
                </button>
                <button
                  onClick={() => setModal({ mode: 'edit', device: d })}
                  title="Edit device"
                  className="rounded-lg p-2 text-fg-faint transition hover:bg-app hover:text-fg-body"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void removeDevice(d.id)}
                  title="Remove device"
                  className="rounded-lg p-2 text-fg-faint transition hover:bg-accent-subtle hover:text-accent-text"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {t?.state === 'ok' && (
                <div className="border-t border-border-subtle px-5 py-4">
                  <InfoGrid info={t.result.info} conn={`${t.result.scheme}:${t.result.port}`} />
                </div>
              )}
              {t?.state === 'fail' && (
                <div className="border-t border-border-subtle px-5 py-3 text-sm text-danger-fg-strong">{t.error}</div>
              )}
            </div>
          );
        })}
      </div>

      {modal && (
        <DeviceModal
          device={modal.mode === 'edit' ? modal.device : undefined}
          sites={sites}
          onSitesChanged={reload}
          onClose={() => setModal(null)}
          onSaved={(keepOpen) => {
            if (!keepOpen) setModal(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

export function InfoGrid({ info, conn }: { info: RouterSystemInfo; conn: string }) {
  const usedMem = info.totalMemory - info.freeMemory;
  const items: Array<{ label: string; value: string; icon?: typeof Cpu }> = [
    { label: 'Identity', value: info.identity ?? '—' },
    { label: 'Model', value: info.model ?? info.boardName ?? '—' },
    { label: 'RouterOS', value: info.version },
    { label: 'Uptime', value: info.uptime },
    { label: 'CPU', value: `${info.cpuLoad}%${info.cpuCount ? ` · ${info.cpuCount} core${info.cpuCount === 1 ? '' : 's'}` : ''}`, icon: Cpu },
    { label: 'Memory', value: `${fmtBytes(usedMem)} / ${fmtBytes(info.totalMemory)}`, icon: MemoryStick },
  ];
  if (info.totalHdd !== null && info.freeHdd !== null) {
    items.push({ label: 'Storage', value: `${fmtBytes(info.totalHdd - info.freeHdd)} / ${fmtBytes(info.totalHdd)}`, icon: HardDrive });
  }
  items.push({ label: 'Connection', value: `REST · ${conn}` });
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      {items.map(({ label, value, icon: Icon }) => (
        <div key={label}>
          <dt className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
            {Icon && <Icon className="h-3 w-3" />} {label}
          </dt>
          <dd className="mt-0.5 truncate text-sm font-medium text-fg" title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const NEW_SITE = '__new__';

export function DeviceModal({ device, sites, initial, onSitesChanged, onClose, onSaved }: {
  device?: Device;
  sites: Site[];
  /** Prefill for add mode (e.g. from a discovered topology node). */
  initial?: { name?: string; host?: string };
  onSitesChanged: () => void;
  onClose: () => void;
  onSaved: (keepOpen: boolean) => void;
}) {
  const editing = device !== undefined;
  const [name, setName] = useState(device?.name ?? initial?.name ?? '');
  const [host, setHost] = useState(device?.host ?? initial?.host ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [siteSel, setSiteSel] = useState<string>(device?.siteId ? String(device.siteId) : '');
  const [newSiteName, setNewSiteName] = useState('');
  const [notes, setNotes] = useState(device?.notes ?? '');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [port, setPort] = useState(device?.port ? String(device.port) : '');
  const [conn, setConn] = useState<'auto' | 'https' | 'http'>(
    device === undefined || device.useTls === null ? 'auto' : device.useTls ? 'https' : 'http',
  );
  const [busy, setBusy] = useState<'test' | 'save' | 'saveMore' | null>(null);
  const [test, setTest] = useState<{ ok: true; result: TestResult } | { ok: false; error: string } | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  // Optional write credential — makes the device "manageable" (config writes).
  const [manage, setManage] = useState(editing && device?.manageable === true);
  const [writeUsername, setWriteUsername] = useState('');
  const [writePassword, setWritePassword] = useState('');

  async function resolveSiteId(): Promise<number | null> {
    if (siteSel === NEW_SITE) {
      const created = await api.post<Site>('/api/sites', { name: newSiteName.trim() });
      onSitesChanged();
      setSiteSel(String(created.id));
      return created.id;
    }
    return siteSel ? Number(siteSel) : null;
  }

  function payload(includeName: boolean, siteId: number | null) {
    return {
      ...(includeName ? { name: name.trim() || host.trim() } : {}),
      host: host.trim(),
      username,
      password,
      siteId,
      notes: notes.trim() || null,
      ...(port ? { port: Number(port) } : { port: null }),
      useTls: conn === 'auto' ? null : conn === 'https',
      // Write credential: null clears it (monitor-only); a value sets/updates it;
      // undefined (manage on, fields blank on edit) leaves the stored one as-is.
      ...(manage
        ? (writeUsername || writePassword ? { writeUsername, writePassword } : {})
        : { writeUsername: null, writePassword: null }),
    };
  }

  async function runTest() {
    setBusy('test');
    setTest(null);
    try {
      const result = await api.post<TestResult>('/api/devices/test', {
        host: host.trim(), username, password,
        ...(port ? { port: Number(port) } : {}),
        useTls: conn === 'auto' ? null : conn === 'https',
      });
      setTest({ ok: true, result });
    } catch (err) {
      setTest({ ok: false, error: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function save(keepOpen: boolean) {
    setBusy(keepOpen ? 'saveMore' : 'save');
    setSavedFlash(null);
    try {
      const siteId = await resolveSiteId();
      if (editing) {
        await api.patch(`/api/devices/${device.id}`, payload(true, siteId));
      } else {
        await api.post('/api/devices', payload(true, siteId));
      }
      if (keepOpen) {
        setSavedFlash(`Added "${name.trim() || host.trim()}" — add the next one`);
        setName('');
        setHost('');
        setNotes('');
        setTest(null);
      }
      onSaved(keepOpen);
    } catch (err) {
      setTest({ ok: false, error: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const canSubmit = host.trim() !== '' && (editing || username !== '') && busy === null
    && (siteSel !== NEW_SITE || newSiteName.trim() !== '');
  const canTest = host.trim() !== '' && username !== '' && password !== '' && busy === null;

  const inputCls =
    'w-full rounded-lg border border-border-strong px-3 py-2 text-sm text-fg-strong outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';
  const labelCls = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-dim';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-6 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-fg-strong">{editing ? 'Edit device' : 'Add device'}</h2>
            <p className="mt-0.5 text-sm text-fg-dim">RouterOS 7.1+ with the www or www-ssl service enabled.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app hover:text-fg-body">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void save(false); }} className="mt-5 space-y-4">
          {savedFlash && (
            <div className="rounded-lg border border-success-line bg-success-bg px-3 py-2 text-sm font-medium text-success-fg">
              {savedFlash}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className={labelCls}>Name</span>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Office gateway" autoFocus={!editing} />
            </label>
            <label className="block">
              <span className={labelCls}>Host / IP</span>
              <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.88.1" required />
            </label>
            <label className="block">
              <span className={labelCls}>Username</span>
              <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)}
                autoComplete="off" required={!editing} placeholder={editing ? 'Leave blank to keep current' : ''} />
            </label>
            <label className="block">
              <span className={labelCls}>Password</span>
              <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password" placeholder={editing ? 'Leave blank to keep current' : ''} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className={labelCls}>Site</span>
              <select className={inputCls} value={siteSel} onChange={(e) => setSiteSel(e.target.value)}>
                <option value="">No site (unassigned)</option>
                {sites.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                <option value={NEW_SITE}>＋ New site…</option>
              </select>
            </label>
            {siteSel === NEW_SITE ? (
              <label className="block">
                <span className={labelCls}>New site name</span>
                <input className={inputCls} value={newSiteName} onChange={(e) => setNewSiteName(e.target.value)}
                  placeholder="Client HQ" required />
              </label>
            ) : (
              <label className="block">
                <span className={labelCls}>Notes (optional)</span>
                <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Rack 2, uplink to fibre" />
              </label>
            )}
          </div>

          {/* Optional write credential → makes the device manageable */}
          <div className="rounded-xl border border-border p-3.5">
            <label className="flex items-start gap-2.5">
              <input type="checkbox" checked={manage} onChange={(e) => setManage(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent" />
              <span>
                <span className="block text-sm font-semibold text-fg">Enable configuration (manageable)</span>
                <span className="block text-xs text-fg-dim">
                  Add a separate write-capable RouterOS credential (group=write or full). Monitoring keeps
                  using the read credential above; writes use this one. Leave off for monitor-only.
                </span>
              </span>
            </label>
            {manage && (
              <div className="mt-3 grid grid-cols-2 gap-4">
                <label className="block">
                  <span className={labelCls}>Write username</span>
                  <input className={inputCls} value={writeUsername} onChange={(e) => setWriteUsername(e.target.value)}
                    autoComplete="off" placeholder={editing && device?.manageable ? 'Leave blank to keep current' : ''} />
                </label>
                <label className="block">
                  <span className={labelCls}>Write password</span>
                  <input className={inputCls} type="password" value={writePassword} onChange={(e) => setWritePassword(e.target.value)}
                    autoComplete="new-password" placeholder={editing && device?.manageable ? 'Leave blank to keep current' : ''} />
                </label>
              </div>
            )}
          </div>

          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs font-semibold text-fg-dim hover:text-accent-text">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            Advanced
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-2 gap-4 rounded-xl bg-sunken p-4">
              <label className="block">
                <span className={labelCls}>Connection</span>
                <select className={inputCls} value={conn} onChange={(e) => setConn(e.target.value as typeof conn)}>
                  <option value="auto">Auto (try HTTPS, then HTTP)</option>
                  <option value="https">HTTPS only</option>
                  <option value="http">HTTP only</option>
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Port</span>
                <input className={inputCls} value={port} onChange={(e) => setPort(e.target.value)}
                  placeholder="443 / 80" inputMode="numeric" />
              </label>
            </div>
          )}

          {test && !test.ok && (
            <div className="flex items-start gap-2 rounded-lg border border-danger-line bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {test.error}
            </div>
          )}
          {test?.ok && (
            <div className="rounded-lg border border-success-line bg-success-bg p-3.5">
              <div className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold text-success-fg">
                <CheckCircle2 className="h-4 w-4" /> Connected successfully
              </div>
              <InfoGrid info={test.result.info} conn={`${test.result.scheme}:${test.result.port}`} />
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={!canTest}
              title={editing && password === '' ? 'Enter the password to run a live test, or save and use Test on the list' : undefined}
              className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text disabled:opacity-50"
            >
              {busy === 'test' && <Loader2 className="h-4 w-4 animate-spin" />}
              Test connection
            </button>
            {!editing && (
              <button
                type="button"
                onClick={() => void save(true)}
                disabled={!canSubmit}
                className="rounded-lg border border-accent-border px-4 py-2 text-sm font-semibold text-accent-text transition hover:bg-accent-subtle disabled:opacity-50"
              >
                {busy === 'saveMore' ? 'Saving…' : 'Save & add another'}
              </button>
            )}
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Save device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
