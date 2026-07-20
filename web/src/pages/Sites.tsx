import { useCallback, useEffect, useState } from 'react';
import { Building2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { Site } from '../types';

export default function Sites() {
  const [sites, setSites] = useState<Site[]>([]);
  const [modal, setModal] = useState<{ mode: 'add' } | { mode: 'edit'; site: Site } | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.get<Site[]>('/api/sites').then(setSites).catch(() => {});
  }, []);

  useEffect(() => reload(), [reload]);

  async function remove(site: Site) {
    if (!confirm(`Delete site "${site.name}"?`)) return;
    setListError(null);
    try {
      await api.del(`/api/sites/${site.id}`);
      reload();
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Sites</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Group devices by location or client — the fleet overview rolls health up per site.
          </p>
        </div>
        <button
          onClick={() => setModal({ mode: 'add' })}
          className="inline-flex items-center gap-2 rounded-lg bg-ruby-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ruby-500"
        >
          <Plus className="h-4 w-4" /> Add site
        </button>
      </div>

      {listError && (
        <div className="mt-4 rounded-lg border border-ruby-200 bg-ruby-50 px-3 py-2 text-sm text-ruby-800">
          {listError}
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sites.length === 0 && (
          <div className="col-span-full rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-10 text-center text-sm text-zinc-500">
            No sites yet. Create one (e.g. "Head Office" or a client name) and assign devices to it.
          </div>
        )}
        {sites.map((s) => (
          <div key={s.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-ruby-50">
                  <Building2 className="h-4.5 w-4.5 text-ruby-600" />
                </div>
                <div>
                  <div className="font-semibold text-zinc-900">{s.name}</div>
                  <div className="text-xs text-zinc-500">
                    {[s.location, s.clientName].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setModal({ mode: 'edit', site: s })} title="Edit site"
                  className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700">
                  <Pencil className="h-4 w-4" />
                </button>
                <button onClick={() => void remove(s)} title="Delete site"
                  className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-ruby-50 hover:text-ruby-700">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-3 text-xs text-zinc-500">
              {s.deviceCount} device{s.deviceCount === 1 ? '' : 's'}
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <SiteModal
          site={modal.mode === 'edit' ? modal.site : undefined}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); reload(); }}
        />
      )}
    </div>
  );
}

function SiteModal({ site, onClose, onSaved }: { site?: Site; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(site?.name ?? '');
  const [location, setLocation] = useState(site?.location ?? '');
  const [clientName, setClientName] = useState(site?.clientName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, location: location || null, clientName: clientName || null };
      if (site) await api.patch(`/api/sites/${site.id}`, body);
      else await api.post('/api/sites', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-ruby-500 focus:ring-2 focus:ring-ruby-500/20';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-zinc-900">{site ? 'Edit site' : 'Add site'}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={(e) => void save(e)} className="mt-4 space-y-4">
          {error && (
            <div className="rounded-lg border border-ruby-200 bg-ruby-50 px-3 py-2 text-sm text-ruby-800">{error}</div>
          )}
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Name</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Head Office" autoFocus required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Location (optional)</span>
            <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="Cape Town" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Client (optional)</span>
            <input className={inputCls} value={clientName} onChange={(e) => setClientName(e.target.value)}
              placeholder="Acme (Pty) Ltd" />
          </label>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50">
              Cancel
            </button>
            <button type="submit" disabled={busy || !name.trim()}
              className="rounded-lg bg-ruby-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-ruby-500 disabled:opacity-50">
              {busy ? 'Saving…' : site ? 'Save changes' : 'Create site'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
