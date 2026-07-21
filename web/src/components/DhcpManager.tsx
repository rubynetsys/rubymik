import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, Lock, Pencil, Pin, Plus, RotateCcw, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { api } from '../api';
import Select from './Select';
import type { ApplyOutcome, DhcpManagement, DhcpLease } from '../types';

/**
 * DHCP reservation management. Every mutating action routes through the
 * server's safe-apply pipeline; this component just shows before→after and
 * the outcome (applied / rolled_back / …). Read-only when the device is
 * monitor-only.
 */
export default function DhcpManager({ deviceId }: { deviceId: number }) {
  const [data, setData] = useState<DhcpManagement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; lease: DhcpLease }>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; o: ApplyOutcome } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<DhcpManagement>(`/api/devices/${deviceId}/dhcp`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  async function removeReservation(lease: DhcpLease) {
    if (!confirm(`Remove reservation ${lease.address} (${lease['mac-address']})? This deletes the static lease on the device.`)) return;
    setBusyId(lease['.id']);
    try {
      const o = await api.del<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/reservations/${encodeURIComponent(lease['.id'])}`);
      setOutcome({ title: `Remove ${lease.address}`, o });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function makeStatic(lease: DhcpLease) {
    setBusyId(lease['.id']);
    try {
      const o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/make-static`, { leaseId: lease['.id'] });
      setOutcome({ title: `Pin ${lease.address} → ${lease['mac-address']}`, o });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (error && !data) {
    return <div className="rounded-lg bg-danger-bg px-3 py-2.5 text-sm text-danger-fg-strong">Could not load DHCP: {error}</div>;
  }
  if (!data) return <div className="h-24 animate-pulse rounded-lg bg-app" />;

  if (data.servers.length === 0) {
    return <div className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">No DHCP server configured on this device.</div>;
  }

  return (
    <div>
      {/* manageable banner */}
      {data.manageable ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-success-bg px-3 py-2 text-xs font-medium text-success-fg">
          <ShieldCheck className="h-4 w-4" /> Manageable — changes go through snapshot → apply → verify → auto-rollback → audit.
        </div>
      ) : (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-app px-3 py-2 text-xs font-medium text-fg-muted">
          <Lock className="h-4 w-4" /> Monitor-only — showing DHCP read-only. Add a write credential (Edit device) to manage reservations.
        </div>
      )}

      {error && <div className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}

      {/* Reservations */}
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wide text-fg-dim">
          Reservations (static) · {data.reservations.length}
        </h3>
        {data.manageable && (
          <button onClick={() => setModal({ mode: 'add' })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-inverse transition hover:bg-accent-hover">
            <Plus className="h-3.5 w-3.5" /> Add reservation
          </button>
        )}
      </div>
      {data.reservations.length === 0 ? (
        <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-dim">No static reservations.</div>
      ) : (
        <LeaseTable leases={data.reservations} manageable={data.manageable} busyId={busyId}
          actions={(l) => (
            <>
              <IconBtn title="Edit" onClick={() => setModal({ mode: 'edit', lease: l })} icon={Pencil} />
              <IconBtn title="Remove" onClick={() => void removeReservation(l)} icon={Trash2} danger />
            </>
          )} />
      )}

      {/* Dynamic leases */}
      <div className="mb-2 mt-5">
        <h3 className="text-xs font-bold uppercase tracking-wide text-fg-dim">Active dynamic leases · {data.dynamic.length}</h3>
      </div>
      {data.dynamic.length === 0 ? (
        <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-dim">
          No dynamic leases right now{data.manageable ? ' — nothing to pin.' : '.'}
        </div>
      ) : (
        <LeaseTable leases={data.dynamic} manageable={data.manageable} busyId={busyId}
          actions={(l) => (
            <button onClick={() => void makeStatic(l)}
              className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-fg-body transition hover:border-accent-border hover:text-accent-text">
              <Pin className="h-3 w-3" /> Make static
            </button>
          )} />
      )}

      {modal && (
        <ReservationModal deviceId={deviceId} servers={data.servers}
          lease={modal.mode === 'edit' ? modal.lease : undefined}
          onClose={() => setModal(null)}
          onDone={(title, o) => { setModal(null); setOutcome({ title, o }); void load(); }} />
      )}
      {outcome && <OutcomeModal title={outcome.title} o={outcome.o} onClose={() => setOutcome(null)} />}
    </div>
  );
}

function LeaseTable({ leases, manageable, actions, busyId }: {
  leases: DhcpLease[]; manageable: boolean; busyId: string | null;
  actions: (l: DhcpLease) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle bg-sunken text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
            <th className="px-3 py-2">IP address</th>
            <th className="px-3 py-2">MAC</th>
            <th className="px-3 py-2">Host / comment</th>
            <th className="px-3 py-2">Server</th>
            {manageable && <th className="px-3 py-2 text-right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {leases.map((l) => (
            <tr key={l['.id']} className="border-b border-border-subtle text-fg-body">
              <td className="px-3 py-2 font-medium text-fg">{l.address ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">{l['mac-address'] ?? '—'}</td>
              <td className="px-3 py-2 text-fg-dim">{l['host-name'] || l.comment || '—'}</td>
              <td className="px-3 py-2 text-fg-dim">{l.server ?? '—'}</td>
              {manageable && (
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1.5">
                    {busyId === l['.id'] ? <Loader2 className="h-4 w-4 animate-spin text-fg-faint" /> : actions(l)}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IconBtn({ title, onClick, icon: Icon, danger }: {
  title: string; onClick: () => void; icon: React.ComponentType<{ className?: string }>; danger?: boolean;
}) {
  return (
    <button title={title} onClick={onClick}
      className={`rounded-md p-1.5 text-fg-faint transition ${danger ? 'hover:bg-danger-bg hover:text-danger-fg' : 'hover:bg-app hover:text-fg-body'}`}>
      <Icon className="h-4 w-4" />
    </button>
  );
}

function ReservationModal({ deviceId, servers, lease, onClose, onDone }: {
  deviceId: number;
  servers: DhcpManagement['servers'];
  lease?: DhcpLease;
  onClose: () => void;
  onDone: (title: string, o: ApplyOutcome) => void;
}) {
  const editing = lease !== undefined;
  const [server, setServer] = useState(lease?.server ?? servers[0]?.name ?? '');
  const [mac, setMac] = useState(lease?.['mac-address'] ?? '');
  const [address, setAddress] = useState(lease?.address ?? '');
  const [comment, setComment] = useState(lease?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let o: ApplyOutcome;
      if (editing) {
        o = await api.patch<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/reservations/${encodeURIComponent(lease['.id'])}`,
          { address, comment });
        onDone(`Edit ${lease.address}`, o);
      } else {
        o = await api.post<ApplyOutcome>(`/api/devices/${deviceId}/dhcp/reservations`,
          { server, mac, address, comment: comment || null });
        onDone(`Add ${address} → ${mac}`, o);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20';
  const labelCls = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-dim';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-fg-strong">{editing ? 'Edit reservation' : 'Add reservation'}</h2>
            <p className="mt-0.5 text-xs text-fg-dim">This is a write action — it goes through the safe-apply pipeline and is audited.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-faint hover:bg-app"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4">
          {error && <div className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg-strong">{error}</div>}
          {!editing && (
            <label className="block">
              <span className={labelCls}>DHCP server</span>
              <Select className={inputCls} value={server} onChange={setServer} ariaLabel="DHCP server"
                options={servers.map((s) => ({ value: s.name, label: `${s.name} (${s.interface})` }))} />
            </label>
          )}
          <label className="block">
            <span className={labelCls}>MAC address</span>
            <input className={inputCls} value={mac} onChange={(e) => setMac(e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF" disabled={editing} required />
          </label>
          <label className="block">
            <span className={labelCls}>IP address</span>
            <input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.90.20" required />
          </label>
          <label className="block">
            <span className={labelCls}>Comment (optional)</span>
            <input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="NAS" />
          </label>
          {/* before → after */}
          {editing && (
            <div className="rounded-lg bg-sunken p-3 text-xs">
              <div className="text-fg-faint">before</div>
              <div className="font-mono text-fg-muted">{lease.address} · {lease.comment || '(no comment)'}</div>
              <div className="mt-1.5 text-fg-faint">after</div>
              <div className="font-mono text-fg">{address} · {comment || '(no comment)'}</div>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-fg-body hover:bg-sunken">Cancel</button>
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse transition hover:bg-accent-hover disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? 'Apply change' : 'Add reservation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const RESULT_META: Record<ApplyOutcome['result'], { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Applied & verified', cls: 'text-success-fg bg-success-bg', Icon: CheckCircle2 },
  rolled_back: { label: 'Auto-rolled back', cls: 'text-warning-fg bg-warning-bg', Icon: RotateCcw },
  rollback_failed: { label: 'Rollback failed', cls: 'text-danger-fg bg-danger-bg', Icon: AlertTriangle },
  failed: { label: 'Failed', cls: 'text-danger-fg bg-danger-bg', Icon: AlertTriangle },
};

function OutcomeModal({ title, o, onClose }: { title: string; o: ApplyOutcome; onClose: () => void }) {
  const m = RESULT_META[o.result];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${m.cls}`}>
          <m.Icon className="h-4 w-4" /> {m.label}
        </div>
        <h2 className="text-base font-semibold text-fg-strong">{title}</h2>
        <p className="mt-1.5 text-sm text-fg-muted">{o.detail}</p>
        <p className="mt-3 text-xs text-fg-faint">Recorded in the audit log (#{o.auditId}).</p>
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-inverse hover:bg-accent-hover">Close</button>
        </div>
      </div>
    </div>
  );
}
