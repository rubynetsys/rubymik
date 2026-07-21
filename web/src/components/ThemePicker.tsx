import { useEffect, useRef, useState } from 'react';
import { Palette, Check } from 'lucide-react';
import { THEMES, ACCENTS, saveTheme } from '../theme';
import { api } from '../api';

/** Sidebar theme switcher — live preview + persists to the logged-in user. */
export default function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('rk-theme') || 'ruby-light');
  const [accent, setAccent] = useState<string>(() => localStorage.getItem('rk-accent') || '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ theme: string | null; accent: string | null }>('/api/me')
      .then((m) => { if (m.theme) setTheme(m.theme); if (m.accent) setAccent(m.accent); }).catch(() => {});
  }, []);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const def = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  function pickTheme(id: string) {
    const uses = THEMES.find((t) => t.id === id)?.usesAccent;
    const nextAccent = uses ? (accent || 'blue') : '';
    setTheme(id); setAccent(nextAccent);
    void saveTheme(id, nextAccent || null);
  }
  function pickAccent(id: string) { setAccent(id); void saveTheme(theme, id); }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-sidebar-idle transition-colors hover:bg-sidebar-fg/10 hover:text-sidebar-hover"
      >
        <Palette className="h-4 w-4" /> <span className="flex-1 text-left">Theme · {def.label}</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-56 overflow-hidden rounded-xl border border-border bg-surface p-2 shadow-2xl">
          <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-fg-faint">Theme</div>
          {THEMES.map((t) => (
            <button key={t.id} onClick={() => pickTheme(t.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${theme === t.id ? 'bg-accent-subtle text-accent-text' : 'text-fg hover:bg-sunken'}`}>
              <span className="flex-1">
                <span className="font-medium">{t.label}</span>
                <span className="block text-[11px] text-fg-dim">{t.hint}</span>
              </span>
              {theme === t.id && <Check className="h-4 w-4 text-accent" />}
            </button>
          ))}
          {def.usesAccent && (
            <>
              <div className="mt-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-fg-faint">Accent</div>
              <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                {ACCENTS.map((a) => (
                  <button key={a.id} onClick={() => pickAccent(a.id)} title={a.id}
                    className={`h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-surface transition ${accent === a.id ? 'ring-fg-faint' : 'ring-transparent'}`}
                    style={{ background: a.hex }} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
