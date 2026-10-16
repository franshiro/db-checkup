import type { PlanScan } from './types.js';

// EXPLAIN trees are loosely typed JSON, so visit every object and array recursively.
function collect(node: unknown, pick: (obj: Record<string, any>) => string | null, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, pick, found);
  } else if (node && typeof node === 'object') {
    const table = pick(node as Record<string, any>);
    if (table) found.add(table);
    for (const value of Object.values(node)) collect(value, pick, found);
  }
}

const toScans = (found: Set<string>): PlanScan[] => [...found].map(table => ({ table }));

// Postgres: EXPLAIN (FORMAT JSON, VERBOSE) output. Only Seq Scan counts as a full table scan.
export function pgScans(explainJson: unknown): PlanScan[] {
  const found = new Set<string>();
  collect(explainJson, o => o['Node Type'] === 'Seq Scan' ? `${o.Schema}.${o['Relation Name']}` : null, found);
  return toScans(found);
}

// MySQL 8 and MariaDB: EXPLAIN FORMAT=JSON. access_type ALL means full table scan.
// Derived tables (named "<derivedN>") are temporary results, not base tables, so they are skipped.
export function mysqlScans(explainJson: unknown): PlanScan[] {
  const found = new Set<string>();
  collect(explainJson, o => o.access_type === 'ALL' && typeof o.table_name === 'string' && !o.table_name.startsWith('<') ? o.table_name : null, found);
  return toScans(found);
}
