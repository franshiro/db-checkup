import { setTimeout as delay } from 'node:timers/promises';
import { LONG_RUNNING_SECONDS, SkipError } from './types.js';
import type { AnalysisResult, DbAdapter, Outcome, PlanScan, StatementStat, Suggestion } from './types.js';
import { diffStatements, isOwnOrSystemQuery, topByTotal } from './stats.js';
import { maskSql } from './mask.js';
import { SqlParseError } from './sql-usage.js';
import { suggestIndexes } from './suggest.js';

export async function analyze(adapter: DbAdapter, opts: { connection: string; top: number; watchSeconds?: number;
  sleep?: (ms: number) => Promise<void>; onTick?: (secondsLeft: number) => void }): Promise<AnalysisResult> {
  const { top, watchSeconds, sleep = (ms: number) => delay(ms), onTick } = opts;
  const { dialect } = adapter;
  const why = (err: unknown) => err instanceof SkipError ? err.message
    : adapter.describeError(err) ?? `Gagal: ${maskSql(err instanceof Error ? err.message : String(err), dialect)}`;
  const run = async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
    try { return { ok: true, value: await fn() }; } catch (err) { return { ok: false, reason: why(err) }; }
  };

  const info = await adapter.info();
  const snapshot = async () => (await adapter.statements()).filter(s => !isOwnOrSystemQuery(s.query));

  let current: Outcome<StatementStat[]> | undefined;
  const cumulative = await run(async () => {
    const s1 = await snapshot();
    if (!watchSeconds) return topByTotal(s1, top);
    for (let n = watchSeconds; n >= 1; n--) { onTick?.(n); await sleep(1000); }
    const s2 = await snapshot();
    current = { ok: true, value: topByTotal(diffStatements(s1, s2), top) };
    return topByTotal(s2, top);
  });
  if (watchSeconds && !current) current = cumulative as Outcome<StatementStat[]>;

  const suggestions = await run(async () => {
    const [tables, indexes] = await Promise.all([adapter.tables(), adapter.indexes()]);
    const uniq = new Map<string, StatementStat>();
    for (const o of [current, cumulative]) if (o?.ok) for (const s of o.value) uniq.set(s.key, s);
    const items: Suggestion[] = [], skipped: { query: string; reason: string }[] = [];
    for (const stat of uniq.values()) {
      let scans: PlanScan[] | null = null, noPlanReason: string | undefined;
      try { scans = await adapter.explain(stat); } catch (err) { noPlanReason = err instanceof SkipError ? err.message : maskSql(err instanceof Error ? err.message : String(err), dialect); }
      try {
        for (const s of suggestIndexes({ query: stat.query, dialect, defaultSchema: adapter.defaultSchema, scans, noPlanReason: noPlanReason ?? '', tables, indexes })) items.push({ query: stat.query, ...s });
      } catch (err) {
        if (!(err instanceof SqlParseError)) throw err;
        skipped.push({ query: stat.query, reason: 'SQL tidak bisa di-parse' });
      }
    }
    return { items, skipped };
  });

  return {
    connection: opts.connection, info, ...(watchSeconds ? { watchSeconds } : {}),
    ...(current ? { current } : {}), cumulative, suggestions,
    tableScans: await run(() => adapter.tableScans(top)),
    foreignKeys: await run(() => adapter.unindexedForeignKeys()),
    unusedIndexes: await run(() => adapter.unusedIndexes(top)),
    running: await run(() => adapter.longRunning(LONG_RUNNING_SECONDS)),
    locks: await run(() => adapter.lockWaits()),
  };
}
