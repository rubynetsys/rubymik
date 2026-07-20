/**
 * Access scoping — the multi-tenancy seam.
 *
 * P1 ships single-admin, so every request runs with `allSites()`. But every
 * query that returns sites, devices, or device status goes through this
 * filter, keyed on the owning site. When per-user tenancy lands, scoping a
 * user becomes a data change (e.g. a `user_sites` join table feeding
 * `siteScope(ids)` at request time) — not a rewrite of the query layer.
 *
 * Convention: devices with `site_id IS NULL` ("Unassigned") are visible to
 * unscoped (admin) access only.
 */
export type AccessScope =
  | { all: true }
  | { all: false; siteIds: number[] };

export function allSites(): AccessScope {
  return { all: true };
}

export function siteScope(siteIds: number[]): AccessScope {
  return { all: false, siteIds };
}

/**
 * SQL fragment (prefixed with AND) restricting `column` to the scope's sites.
 * Append inside an existing WHERE clause; spread `params` after it.
 */
export function scopeFilter(scope: AccessScope, column: string): { sql: string; params: number[] } {
  if (scope.all) return { sql: '', params: [] };
  if (scope.siteIds.length === 0) return { sql: ' AND 1 = 0', params: [] };
  return {
    sql: ` AND ${column} IN (${scope.siteIds.map(() => '?').join(', ')})`,
    params: scope.siteIds,
  };
}
