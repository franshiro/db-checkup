import { setTimeout as delay } from 'node:timers/promises';
import { LONG_RUNNING_SECONDS, SkipError } from './types.js';
import type { AnalysisPart, AnalysisResult, DbAdapter, Outcome, PlanScan, StatementStat, Suggestion } from './types.js';
import { diffStatements, isOwnOrSystemQuery, topByTotal } from './stats.js';
import { maskSql } from './mask.js';
import { SqlParseError } from './sql-usage.js';
import { suggestIndexes } from './suggest.js';

export async function analyze(adapter: DbAdapter, opts: { connection: string; top: number; watchSeconds?: number;
  sleep?: (ms: number) => Promise<void>; onTick?: (secondsLeft: number) => void;
  parts?: AnalysisPart[]; signal?: AbortSignal }): Promise<AnalysisResult> {
  const { top, watchSeconds, sleep = (ms: number) => delay(ms, undefined, { signal: opts.signal }), onTick, signal } = opts;
  const want = opts.parts && new Set(opts.parts);
  const { dialect } = adapter;
  const why = (err: unknown) => err instanceof SkipError ? err.message
    : adapter.describeError(err) ?? `Gagal: ${maskError(err)}`;
  // Postgres error messages quote values with "..."; maskSql treats those as identifiers, so blank them here.
  const maskError = (err: unknown) => {
    const m = err instanceof Error ? err.message : String(err);
    return maskSql(dialect === 'postgres' ? m.replace(/"[^"]*"/g, '"?"') : m, dialect);
  };
  const run = async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
    try { return { ok: true, value: await fn() }; } catch (err) { if ((err as Error)?.name === 'AbortError') throw err; return { ok: false, reason: why(err) }; }
  };
  // Unrequested part -> undefined; abort is checked before each step.
  const part = <T>(p: AnalysisPart, fn: () => Promise<T>): Promise<Outcome<T> | undefined> | undefined =>
    !want || want.has(p) ? (signal?.throwIfAborted(), run(fn)) : undefined;

  const info = await adapter.info();
  const snapshot = async () => (await adapter.statements()).filter(s => !isOwnOrSystemQuery(s.query));

  let current: Outcome<StatementStat[]> | undefined;
  const cumulative = await part('statements', async () => {
    const s1 = await snapshot();
    if (!watchSeconds) return topByTotal(s1, top);
    for (let n = watchSeconds; n >= 1; n--) { signal?.throwIfAborted(); onTick?.(n); signal?.throwIfAborted(); await sleep(1000); }
    signal?.throwIfAborted();
    const s2 = await snapshot();
    current = { ok: true, value: topByTotal(diffStatements(s1, s2), top) };
    return topByTotal(s2, top);
  });
  if (watchSeconds && cumulative && !current) current = cumulative as Outcome<StatementStat[]>;

  const suggestions = await part('suggestions', async () => {
    const own = cumulative ? undefined : topByTotal(await snapshot(), top);
    const [tables, indexes] = await Promise.all([adapter.tables(), adapter.indexes()]);
    const uniq = new Map<string, StatementStat>();
    for (const o of [current, cumulative]) if (o?.ok) for (const s of o.value) uniq.set(s.key, s);
    for (const s of own ?? []) uniq.set(s.key, s);
    const items: Suggestion[] = [], skipped: { query: string; reason: string }[] = [];
    for (const stat of uniq.values()) {
      signal?.throwIfAborted();
      let scans: PlanScan[] | null = null, noPlanReason: string | undefined;
      try { scans = await adapter.explain(stat); } catch (err) { noPlanReason = err instanceof SkipError ? err.message : maskError(err); }
      try {
        for (const s of suggestIndexes({ query: stat.query, dialect, defaultSchema: adapter.defaultSchema, scans, noPlanReason: noPlanReason ?? '', tables, indexes })) items.push({ query: stat.query, ...s });
      } catch (err) {
        if (!(err instanceof SqlParseError)) throw err;
        if (/^\s*(select|with|update|delete)\b/i.test(stat.query)) skipped.push({ query: stat.query, reason: 'SQL tidak bisa di-parse' });
      }
    }
    return { items, skipped };
  });

  return {
    connection: opts.connection, info, ...(watchSeconds ? { watchSeconds } : {}),
    ...(current ? { current } : {}), cumulative, suggestions,
    tableScans: await part('tableScans', () => adapter.tableScans(top)),
    foreignKeys: await part('foreignKeys', () => adapter.unindexedForeignKeys()),
    unusedIndexes: await part('unusedIndexes', () => adapter.unusedIndexes(top)),
    running: await part('running', () => adapter.longRunning(LONG_RUNNING_SECONDS)),
    locks: await part('locks', () => adapter.lockWaits()),
  };
}
