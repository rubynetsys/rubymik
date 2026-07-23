import { useState } from 'react';
import { Copy, Check, TextCursorInput } from 'lucide-react';
import { copyText, selectElementText } from '../lib/clipboard';

/**
 * A Copy button that ALWAYS gives feedback (v1.1.3):
 *   success → "Copied" for 2s (works over HTTP via the copyText fallback);
 *   total failure → selects the source text and shows "Press Ctrl+C", so the user
 *   is never left with a silent no-op.
 *
 * `getSelect` returns the element to select on failure (e.g. the <pre> holding the
 * text). Style comes from `className` so each call site keeps its own look.
 */
export default function CopyButton({
  text, className, label = 'Copy', iconClass = 'h-3.5 w-3.5', getSelect,
}: {
  text: string;
  className?: string;
  label?: string;
  iconClass?: string;
  getSelect?: () => HTMLElement | null;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');

  async function run() {
    const ok = await copyText(text);
    if (ok) {
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } else {
      selectElementText(getSelect?.() ?? null);
      setState('manual');
      setTimeout(() => setState('idle'), 6000);
    }
  }

  const cls = className ?? 'inline-flex items-center gap-1 rounded-md bg-sidebar px-2.5 py-1 text-xs font-semibold text-inverse hover:bg-fg-body';
  return (
    <button type="button" onClick={() => void run()} className={cls}
      title={state === 'manual' ? 'Copy failed — the text is selected; press Ctrl+C (⌘C on Mac)' : undefined}>
      {state === 'copied' ? <><Check className={iconClass} /> Copied</>
        : state === 'manual' ? <><TextCursorInput className={iconClass} /> Press Ctrl+C</>
          : <><Copy className={iconClass} /> {label}</>}
    </button>
  );
}
