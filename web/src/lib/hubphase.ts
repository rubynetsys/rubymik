// P45 — the Remote Access page state machine (pure, so it can be unit-tested
// without a DOM). Capability is the top gate: a not-capable install can never
// reach a clickable Enable, so "not running" + a dead Enable never coexist with
// missing caps.
//
//   not-capable            -> 'setup'    (setup card; no Enable button)
//   capable, hub disabled  -> 'ready'    (configure endpoint + a live Enable)
//   capable, hub enabled   -> 'running'  (status, sites, config)

export type HubPhase = 'setup' | 'ready' | 'running';

export function phaseFor(capable: boolean, hubEnabled: boolean): HubPhase {
  if (!capable) return 'setup';
  if (!hubEnabled) return 'ready';
  return 'running';
}
