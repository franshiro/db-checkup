import type { StatementStat } from './types.js';

export function topByTotal(stats: StatementStat[], n: number): StatementStat[] {
  return [...stats].sort((a, b) => b.totalMs - a.totalMs).slice(0, n);
}

// Counter delta between two snapshots. If a counter went down (stats reset), the second value is used as-is.
const delta = (before: number, after: number) => (after < before ? after : after - before);

export function diffStatements(before: StatementStat[], after: StatementStat[]): StatementStat[] {
  const prev = new Map(before.map(x => [x.key, x]));
  const out: StatementStat[] = [];
  for (const cur of after) {
    const p = prev.get(cur.key);
    const calls = p ? delta(p.calls, cur.calls) : cur.calls;
    const totalMs = p ? delta(p.totalMs, cur.totalMs) : cur.totalMs;
    if (totalMs <= 0) continue;
    const stat: StatementStat = {
      key: cur.key,
      query: cur.query,
      calls,
      totalMs,
      meanMs: calls === 0 ? 0 : totalMs / calls,
      rows: p ? delta(p.rows, cur.rows) : cur.rows,
    };
    if (cur.sample !== undefined) stat.sample = cur.sample;
    if (cur.rowsExamined !== undefined) stat.rowsExamined = p ? delta(p.rowsExamined ?? 0, cur.rowsExamined) : cur.rowsExamined;
    if (cur.noIndexUsed !== undefined) stat.noIndexUsed = p ? delta(p.noIndexUsed ?? 0, cur.noIndexUsed) : cur.noIndexUsed;
    out.push(stat);
  }
  return out;
}

const OWN_PREFIX = /^\s*(EXPLAIN|SET|PREPARE|DEALLOCATE|SHOW|BEGIN|COMMIT|ROLLBACK)\b/i;
// MySQL digests quote and space identifiers (`sys` . `x`, `VERSION` ( )), hence the optional backticks/whitespace.
const SYSTEM_REF = /\/\* db-checkup \*\/|pg_catalog|pg_stat_|information_schema|performance_schema|\b(sys|mysql)`?\s*\.\s*`?\w|@@`?\w|\b(version|connection_id)`?\s*\(/i;

export function isOwnOrSystemQuery(sql: string): boolean {
  return OWN_PREFIX.test(sql) || SYSTEM_REF.test(sql);
}
