import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RadioTower, KeyRound, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { type PendingItem, pendingCopy } from '../lib/pending';

/**
 * The pending-setup feed (v1.1.8) — remote sites awaiting key + provisioned-not-yet-
 * adopted routers. ONE implementation for both surfaces: the Dashboard card
 * (variant="card") and the Devices page section (variant="section"). Hidden when
 * empty (never a permanently empty widget). Rows are non-clickable into device
 * detail (there is no device yet) — each links to Finish setup instead.
 */
export default function PendingSetup({ variant }: { variant: 'card' | 'section' }) {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const load = useCallback(() => {
    api.get<{ items: PendingItem[] }>('/api/remote-access/pending').then((r) => setItems(r.items)).catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (!items || items.length === 0) return null; // hidden when empty

  const rows = (
    <ul className="divide-y divide-border-subtle">
      {items.map((it) => {
        const c = pendingCopy(it);
        return (
          <li key={it.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app text-fg-faint">
              {it.hasKey ? <RadioTower className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg-body">{it.label}</div>
              <div className="truncate text-xs text-fg-faint">{c.sub}</div>
            </div>
            <span className="shrink-0 rounded-full bg-info-bg px-2 py-0.5 text-[11px] font-semibold text-info-fg">{c.chip}</span>
            <Link to="/remote-access" className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent-text hover:underline">
              Finish setup <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );

  if (variant === 'card') {
    return (
      <section className="rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <RadioTower className="h-4 w-4 text-accent" />
          <h2 className="text-xs font-bold uppercase tracking-wide text-fg-dim">Pending setup · {items.length}</h2>
        </div>
        {rows}
      </section>
    );
  }
  return (
    <div className="rounded-2xl border border-dashed border-border-strong bg-surface/60">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <RadioTower className="h-4 w-4 text-accent" />
        <h2 className="text-xs font-bold uppercase tracking-wide text-fg-dim">Pending setup · {items.length}</h2>
        <span className="text-[11px] text-fg-faint">provisioned, not yet adopted — not counted in fleet health</span>
      </div>
      <div className="border-t border-border-subtle">{rows}</div>
    </div>
  );
}
