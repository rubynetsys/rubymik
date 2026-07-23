import { useRef } from 'react';
import { Download } from 'lucide-react';
import CopyButton from './CopyButton';
import { downloadText } from '../lib/clipboard';

/**
 * A code/script block with actions that work over plain HTTP (v1.1.3):
 *   - Copy (via the copyText fallback; selects this block + "Press Ctrl+C" on total failure)
 *   - Download (Blob) when `filename` is given — for large blocks (compose files,
 *     .rsc scripts) download is often the better primary action anyway.
 */
export default function CodeBlock({
  code, label, filename, maxHeightClass = 'max-h-80',
}: {
  code: string;
  label?: string;
  filename?: string;
  maxHeightClass?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const btn = 'inline-flex items-center gap-1 rounded-md bg-sidebar px-2.5 py-1 text-xs font-semibold text-inverse hover:bg-fg-body';
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 bg-app px-3 py-1.5">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{label ?? 'file'}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {filename && (
            <button type="button" onClick={() => downloadText(filename, code)} className={btn}>
              <Download className="h-3.5 w-3.5" /> Download
            </button>
          )}
          <CopyButton text={code} className={btn} getSelect={() => preRef.current} />
        </div>
      </div>
      <pre ref={preRef} className={`overflow-auto bg-sidebar p-3 text-[11px] leading-relaxed text-inverse ${maxHeightClass}`}><code>{code}</code></pre>
    </div>
  );
}
