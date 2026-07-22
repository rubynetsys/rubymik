import { randomUUID } from 'node:crypto';

/**
 * P35 — fleet update orchestrator. Plans and paces a RouterOS update across many
 * devices on top of P34's per-device pipeline: a CANARY first (prove one returns
 * healthy), then controlled BATCHES, HALTING the moment a device fails to return,
 * and ABORTable between stages. Monitor-only and already-up-to-date devices are
 * EXCLUDED (never touched).
 *
 * The destructive per-device install is P34's attended path; this module owns the
 * orchestration — the planner and the stage state-machine are pure/injected so the
 * whole flow can be rehearsed dry (real device states, no writes) and unit-tested.
 */

export interface FleetTarget {
  id: number; name: string; manageable: boolean; reachable: boolean;
  updateAvailable: boolean | null; installed: string | null; latest: string | null;
}
export interface FleetConfig { canaryCount: number; batchSize: number; haltOnFailure: boolean }
export const DEFAULT_FLEET_CONFIG: FleetConfig = { canaryCount: 1, batchSize: 5, haltOnFailure: true };

export interface PlanItem { id: number; name: string; installed: string | null; latest: string | null }
export interface Excluded { id: number; name: string; reason: string }
export interface FleetPlan { canary: PlanItem[]; batches: PlanItem[][]; excluded: Excluded[]; total: number }

const clampCfg = (c?: Partial<FleetConfig>): FleetConfig => ({
  canaryCount: Math.min(Math.max(Math.floor(c?.canaryCount ?? DEFAULT_FLEET_CONFIG.canaryCount), 0), 10),
  batchSize: Math.min(Math.max(Math.floor(c?.batchSize ?? DEFAULT_FLEET_CONFIG.batchSize), 1), 50),
  haltOnFailure: c?.haltOnFailure ?? DEFAULT_FLEET_CONFIG.haltOnFailure,
});

/** Pure planner: exclude what can't/shouldn't update, then order canary → batches. */
export function planFleetUpdate(targets: FleetTarget[], config?: Partial<FleetConfig>): FleetPlan {
  const cfg = clampCfg(config);
  const excluded: Excluded[] = [];
  const eligible: PlanItem[] = [];
  for (const t of targets) {
    if (!t.manageable) { excluded.push({ id: t.id, name: t.name, reason: 'Monitor-only (no write credential)' }); continue; }
    if (!t.reachable) { excluded.push({ id: t.id, name: t.name, reason: 'Not reachable' }); continue; }
    if (t.updateAvailable !== true) {
      excluded.push({ id: t.id, name: t.name, reason: t.latest ? `Already up to date (${t.installed ?? '?'})` : 'Latest unknown — not checked' });
      continue;
    }
    eligible.push({ id: t.id, name: t.name, installed: t.installed, latest: t.latest });
  }
  const canary = eligible.slice(0, cfg.canaryCount);
  const rest = eligible.slice(cfg.canaryCount);
  const batches: PlanItem[][] = [];
  for (let i = 0; i < rest.length; i += cfg.batchSize) batches.push(rest.slice(i, i + cfg.batchSize));
  return { canary, batches, excluded, total: eligible.length };
}

// ---------------- run state machine ----------------

export type TargetStatus = 'queued' | 'updating' | 'done' | 'failed' | 'skipped';
export type RunPhase = 'running' | 'done' | 'halted' | 'aborted';
export interface RunTarget { id: number; name: string; stage: 'canary' | 'batch'; batch: number; status: TargetStatus; detail?: string }
export interface RunState {
  id: string; dryRun: boolean; config: FleetConfig; phase: RunPhase;
  targets: RunTarget[]; log: string[]; startedAt: string; finishedAt?: string;
}

/** Outcome of updating one device: it returned healthy, or it did not. */
export type ProcessOne = (item: PlanItem) => Promise<'done' | 'failed'>;

export class FleetUpdater {
  private runs = new Map<string, RunState & { aborted: boolean }>();

  /** Start a run against a plan. `processOne` does the real work (or a dry sim);
   *  `now` supplies timestamps (no ambient clock, so runs are deterministic in tests). */
  start(plan: FleetPlan, config: FleetConfig, dryRun: boolean, processOne: ProcessOne, now: () => string): string {
    const id = randomUUID();
    const stages = this.stagesOf(plan);
    const targets: RunTarget[] = stages.flatMap((s) => s.items.map((it) => ({ id: it.id, name: it.name, stage: s.kind, batch: s.batch, status: 'queued' as TargetStatus })));
    const run: RunState & { aborted: boolean } = {
      id, dryRun, config, phase: 'running', targets, log: [`${now()} run ${dryRun ? '(dry-run) ' : ''}started — ${plan.total} device(s): 1 canary + ${plan.batches.length} batch(es)`],
      startedAt: now(), aborted: false,
    };
    this.runs.set(id, run);
    void this.execute(run, stages, processOne, now);
    return id;
  }

  status(id: string): RunState | undefined {
    const r = this.runs.get(id);
    if (!r) return undefined;
    const { aborted, ...pub } = r; void aborted;
    return pub;
  }
  abort(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || r.phase !== 'running') return false;
    r.aborted = true; r.log.push(`${new Date().toISOString()} abort requested — no new stage will start`);
    return true;
  }
  list(): RunState[] { return [...this.runs.values()].map((r) => { const { aborted, ...p } = r; void aborted; return p; }); }

  private stagesOf(plan: FleetPlan): Array<{ kind: 'canary' | 'batch'; batch: number; items: PlanItem[] }> {
    const stages: Array<{ kind: 'canary' | 'batch'; batch: number; items: PlanItem[] }> = [];
    if (plan.canary.length) stages.push({ kind: 'canary', batch: 0, items: plan.canary });
    plan.batches.forEach((b, i) => stages.push({ kind: 'batch', batch: i + 1, items: b }));
    return stages;
  }

  private async execute(run: RunState & { aborted: boolean }, stages: Array<{ kind: 'canary' | 'batch'; batch: number; items: PlanItem[] }>, processOne: ProcessOne, now: () => string): Promise<void> {
    const mark = (id: number, status: TargetStatus, detail?: string) => { const t = run.targets.find((x) => x.id === id); if (t) { t.status = status; if (detail) t.detail = detail; } };
    const skipRemaining = () => run.targets.forEach((t) => { if (t.status === 'queued') t.status = 'skipped'; });

    for (const stage of stages) {
      if (run.aborted) { skipRemaining(); run.phase = 'aborted'; run.log.push(`${now()} aborted before ${stage.kind}${stage.kind === 'batch' ? ` ${stage.batch}` : ''}`); run.finishedAt = now(); return; }
      run.log.push(`${now()} ${stage.kind}${stage.kind === 'batch' ? ` ${stage.batch}` : ''} — updating ${stage.items.length} device(s)`);
      const results = await Promise.all(stage.items.map(async (it) => {
        mark(it.id, 'updating');
        try { const r = await processOne(it); mark(it.id, r, r === 'failed' ? 'did not return healthy' : undefined); return r; }
        catch (err) { mark(it.id, 'failed', (err as Error).message); return 'failed' as const; }
      }));
      const failed = results.filter((r) => r === 'failed').length;
      if (failed && run.config.haltOnFailure) {
        skipRemaining(); run.phase = 'halted';
        run.log.push(`${now()} HALTED after ${stage.kind}${stage.kind === 'batch' ? ` ${stage.batch}` : ''}: ${failed} device(s) did not return — ${run.targets.filter((t) => t.status === 'skipped').length} skipped`);
        run.finishedAt = now(); return;
      }
    }
    run.phase = 'done'; run.log.push(`${now()} done — ${run.targets.filter((t) => t.status === 'done').length} updated`); run.finishedAt = now();
  }
}
