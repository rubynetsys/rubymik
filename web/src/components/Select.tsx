import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * One shared dropdown for the whole app (P25). Native <select> OPTION popups
 * ignore the app CSS and render white-on-white in the dark theme; this renders
 * its own themed listbox. Drop-in replacement: same value in, the selected value
 * out via onChange(value) — nothing about what a form submits changes.
 *
 * Keyboard: focus the control, then Enter/Space/↓ opens; ↑/↓ move, Enter selects,
 * Esc closes, Home/End jump, and type-ahead matches option labels.
 */
export interface SelectOption { value: string; label: string; disabled?: boolean }

export default function Select({ value, onChange, options, className, placeholder, id, ariaLabel, disabled }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;   // controls width (e.g. w-full); applied to the wrapper
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef({ str: '', t: 0 });
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { if (open && active >= 0) (listRef.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  const commit = (i: number) => { const o = options[i]; if (o && !o.disabled) { onChange(o.value); setOpen(false); btnRef.current?.focus(); } };
  const move = (d: number) => { if (!options.length) return; let i = active < 0 ? 0 : active; for (let k = 0; k < options.length; k++) { i = (i + d + options.length) % options.length; if (!options[i]?.disabled) break; } setActive(i); };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key.length === 1) {
      const ta = typeahead.current; const t = performance.now();
      ta.str = t - ta.t > 800 ? e.key : ta.str + e.key; ta.t = t;
      const idx = options.findIndex((o) => o.label.toLowerCase().startsWith(ta.str.toLowerCase()));
      if (idx >= 0) setActive(idx);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <button ref={btnRef} type="button" id={id} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)} onKeyDown={onKey}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border-strong bg-app px-3 py-2 text-left text-sm text-fg-body outline-none transition focus:border-accent-border-strong focus:ring-2 focus:ring-accent-border-strong/20 disabled:opacity-50">
        <span className={`truncate ${selected ? '' : 'text-fg-faint'}`}>{selected ? selected.label : (placeholder ?? 'Select…')}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-fg-faint transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul ref={listRef} role="listbox" tabIndex={-1}
          className="absolute z-50 mt-1 max-h-60 w-full min-w-max overflow-auto rounded-lg border border-border-strong bg-surface p-1 shadow-2xl">
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); commit(i); }}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm ${o.disabled ? 'cursor-not-allowed text-fg-faint' : i === active ? 'bg-accent text-inverse' : 'text-fg-body'}`}>
              <span className="truncate">{o.label}</span>
              {o.value === value && <span className={`text-[11px] ${i === active ? 'text-inverse' : 'text-accent-text'}`}>✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
