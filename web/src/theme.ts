/**
 * Theme selection (P12) — purely presentational. A theme is a token-value set
 * applied via data-theme on <html>; accent is data-accent. The default
 * "ruby-light" is :root with no data-theme, so we remove the attribute for it.
 * localStorage caches the choice so the inline script in index.html can apply it
 * before first paint (no flash-of-wrong-theme); the server (users.theme) is the
 * source of truth and syncs on load.
 */
export interface ThemeDef { id: string; label: string; hint: string; usesAccent: boolean; }

export const THEMES: ThemeDef[] = [
  { id: 'ruby-light', label: 'Ruby', hint: 'The brand — light', usesAccent: false },
  { id: 'ruby-dark', label: 'Ruby Dark', hint: 'Ruby palette, dark rooms', usesAccent: false },
  { id: 'modern-dark', label: 'Modern Dark', hint: 'Neutral dark + your accent', usesAccent: true },
  { id: 'modern-light', label: 'Modern Light', hint: 'Neutral light + your accent', usesAccent: true },
  { id: 'glass', label: 'Glass', hint: 'Frosted translucency', usesAccent: true },
  { id: 'classic', label: 'Classic', hint: 'Dense utilitarian admin', usesAccent: true },
];

export const ACCENTS = [
  { id: 'ruby', hex: '#c41e56' }, { id: 'blue', hex: '#2563eb' }, { id: 'red', hex: '#dc2626' },
  { id: 'green', hex: '#15803d' }, { id: 'purple', hex: '#7c3aed' }, { id: 'amber', hex: '#b45309' },
  { id: 'teal', hex: '#0d9488' },
];

export const DEFAULT_THEME = 'ruby-light';

export function applyTheme(theme: string | null, accent: string | null): void {
  const root = document.documentElement;
  const t = theme || DEFAULT_THEME;
  if (t && t !== DEFAULT_THEME) root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  if (accent) root.setAttribute('data-accent', accent);
  else root.removeAttribute('data-accent');
  try {
    localStorage.setItem('rk-theme', t);
    localStorage.setItem('rk-accent', accent || '');
  } catch { /* private mode */ }
}

/** Persist the choice to the logged-in user (server = source of truth). */
export async function saveTheme(theme: string, accent: string | null): Promise<void> {
  applyTheme(theme, accent);
  try {
    await fetch('/api/me/theme', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, accent }),
    });
  } catch { /* offline; localStorage still holds it */ }
}
