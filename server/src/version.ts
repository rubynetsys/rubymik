import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one canonical place the running app learns its own version. Read once from
 * the server package.json (repo: server/package.json; image: /app/package.json —
 * both sit one level above the compiled dist/). Everything that needs to compare
 * "what version is this" — the boot upgrade-guard, the self-backup manifest, the
 * /api/health payload, the update check — reads THIS, so they can never disagree.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8');
    return String((JSON.parse(raw) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();
