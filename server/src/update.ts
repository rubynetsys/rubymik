/**
 * P34 — single-device RouterOS update: the read/precondition core.
 *
 * The install itself is DELIBERATE unreachability (it downloads, reboots, and
 * installs), so the flow reuses P29's expected-outage reboot dead-man — this
 * module only holds the pure, testable pieces: parsing the router's update state
 * and gating an install behind preconditions. RubyMIK NEVER auto-updates and
 * NEVER guesses the latest version — it is only known after check-for-updates has
 * contacted MikroTik's server (a separate, explicit action).
 */

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface UpdateState {
  channel: string | null;
  installed: string | null;
  latest: string | null;
  status: string | null;
  updateAvailable: boolean | null;         // tri-state: only true/false when both versions are known
  firmwareCurrent: string | null;
  firmwareUpgrade: string | null;
  firmwareUpgradeAvailable: boolean | null;
}

/** Fold /system/package/update + /system/routerboard into one honest state. */
export function parseUpdateState(pkg: Dict, rb: Dict | null): UpdateState {
  const installed = s(pkg['installed-version']);
  const latest = s(pkg['latest-version']);
  const fwCur = rb ? s(rb['current-firmware']) : null;
  const fwUp = rb ? s(rb['upgrade-firmware']) : null;
  return {
    channel: s(pkg['channel']),
    installed, latest, status: s(pkg['status']),
    updateAvailable: installed && latest ? installed !== latest : null,
    firmwareCurrent: fwCur, firmwareUpgrade: fwUp,
    firmwareUpgradeAvailable: fwCur && fwUp ? fwCur !== fwUp : null,
  };
}

export interface UpdatePreconditions { ok: boolean; blockers: string[] }

/** Gate an install. Every blocker is a concrete reason it can't safely run now. */
export function checkUpdatePreconditions(
  state: UpdateState,
  ctx: { manageable: boolean; reachable: boolean; rebooting: boolean },
): UpdatePreconditions {
  const b: string[] = [];
  if (!ctx.manageable) b.push('This device is monitor-only — add a write credential to update it.');
  if (!ctx.reachable) b.push('The device is not reachable right now.');
  if (ctx.rebooting) b.push('The device is already rebooting — wait for it to return.');
  if (state.updateAvailable !== true) {
    b.push(state.latest
      ? `Already up to date (installed ${state.installed ?? '?'} = latest ${state.latest}).`
      : 'The latest version is unknown — run "Check for updates" first.');
  }
  if ((state.status ?? '').toLowerCase().includes('download')) b.push('An update download is already in progress on the device.');
  return { ok: b.length === 0, blockers: b };
}
