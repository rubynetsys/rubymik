// The ONE place clipboard access lives (P45.1 / v1.1.3). navigator.clipboard is
// undefined outside a secure context (HTTPS / localhost), and most self-hosted
// RubyMIK installs run plain HTTP on a LAN — so a naive navigator.clipboard call
// silently no-ops for them. copyText() falls back to a hidden-textarea +
// execCommand('copy'), which is deprecated but works everywhere, including HTTP.
//
// No other module may call navigator.clipboard directly (there is a test that
// greps for it) — always go through copyText().

/** Copy text to the clipboard. Async Clipboard API in a secure context; otherwise
 *  a hidden-textarea + execCommand('copy') fallback that works over plain HTTP.
 *  Returns true on success, false if even the fallback failed — the caller should
 *  then offer a manual path (select the text + "Press Ctrl+C"). */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the universal fallback (permissions, transient failure, …)
    }
  }
  return legacyCopy(text);
}

/** Hidden-textarea + execCommand('copy'). Deprecated but universally functional,
 *  including over plain HTTP where the async Clipboard API is unavailable. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    // Preserve any selection the user already had.
    const sel = typeof document.getSelection === 'function' ? document.getSelection() : null;
    const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    ta.focus();
    ta.select();
    if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (prev && sel) { sel.removeAllRanges(); sel.addRange(prev); }
    return ok;
  } catch {
    return false;
  }
}

/** Download text as a file via a Blob. No secure context needed — works over
 *  plain HTTP. For large blocks (compose files, .rsc scripts) this is often the
 *  better primary action anyway. */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Select all text inside an element — the manual "Press Ctrl+C" fallback when a
 *  copy could not be performed programmatically at all. */
export function selectElementText(el: HTMLElement | null): void {
  if (!el) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}
