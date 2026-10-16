import pg from 'pg';
import { MIN_TABLE_ROWS, SkipError } from '../types.js';
import type { DbAdapter, ForeignKeyIssue, IndexInfo, LockWait, RunningQuery, ServerInfo, StatementStat, TableInfo, TableScanStat } from '../types.js';
import { pgScans } from '../plan.js';

const ENABLE_HINT = `pg_stat_statements belum aktif. Cara mengaktifkan:
- Server sendiri: tambahkan shared_preload_libraries = 'pg_stat_statements' di postgresql.conf, restart, lalu jalankan CREATE EXTENSION pg_stat_statements;
- AWS RDS: ubah parameter group shared_preload_libraries, reboot, lalu jalankan CREATE EXTENSION pg_stat_statements;
- Google Cloud SQL: cukup jalankan CREATE EXTENSION pg_stat_statements;`;

// Key columns of an index (INCLUDE columns excluded), stopping at the first expression column (attnum 0).
const INDEXES_SQL = `
  SELECT ix.indexrelid AS oid, n.nspname || '.' || t.relname AS "table", i.relname AS name,
         ix.indisunique AS "unique", ix.indisprimary AS "primary",
         (SELECT coalesce(array_agg(a.attname::text ORDER BY k.ord), '{}') FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
           WHERE k.ord <= ix.indnkeyatts
             AND k.ord < coalesce((SELECT min(k2.ord) FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k2(attnum, ord) WHERE k2.attnum = 0), 1000000)) AS columns
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`;

export async function createPostgresAdapter(url: string): Promise<DbAdapter> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const s of ["SET application_name = 'db-checkup'", 'SET default_transaction_read_only = on', 'SET statement_timeout = 5000',
      'SET lock_timeout = 2000', 'SET plan_cache_mode = force_generic_plan']) await client.query(s);
  } catch (err) { await client.end().catch(() => {}); throw err; }
  const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
  const versionNum = async () => Number((await q('SHOW server_version_num'))[0].server_version_num);
  const hasExtension = async () => (await q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)).length > 0;

  return {
    dialect: 'postgres', defaultSchema: 'public',

    async info(): Promise<ServerInfo> {
      const [{ version, current_database: database }] = await q('SELECT version(), current_database()');
      const num = await versionNum();
      const warnings: string[] = [];
      if (num < 120000) warnings.push('Postgres di bawah 12 tidak didukung resmi; hasil bisa tidak lengkap.');
      const [{ ok }] = await q(`SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS ok`);
      if (!ok) warnings.push('User bukan superuser dan tidak punya role pg_read_all_stats; statistik query bisa tidak lengkap. Jalankan: GRANT pg_read_all_stats TO <user>;');
      let statsSince: Date | null = null;
      if (num >= 140000 && await hasExtension() && (await q(`SELECT to_regclass('pg_stat_statements_info') IS NOT NULL AS ok`))[0].ok) statsSince = (await q('SELECT stats_reset FROM pg_stat_statements_info'))[0]?.stats_reset ?? null;
      return { dialect: 'postgres', flavor: 'postgres', version, database, statsSince, warnings };
    },

    async statements(): Promise<StatementStat[]> {
      if (!await hasExtension()) throw new SkipError(ENABLE_HINT);
      const [total, mean] = await versionNum() < 130000 ? ['total_time', 'mean_time'] : ['total_exec_time', 'mean_exec_time'];
      try {
        const rows = await q(`SELECT userid::text || ':' || queryid::text AS key, query, calls, ${total} AS total_ms, ${mean} AS mean_ms, rows
          FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
        return rows.map(r => ({ key: r.key, query: r.query, calls: Number(r.calls), totalMs: Number(r.total_ms), meanMs: Number(r.mean_ms), rows: Number(r.rows) }));
      } catch (err) {
        if (err instanceof Error && err.message.includes('must be loaded via shared_preload_libraries')) throw new SkipError(ENABLE_HINT);
        throw err;
      }
    },

    async explain(stmt: StatementStat) {
      // Conservative: a WITH containing any DML keyword (outside string literals) is refused; planning DML would lock its target table.
      const noStrings = stmt.query.replace(/'(?:[^']|'')*'/g, "''");
      if (!/^\s*(select|with)\b/i.test(stmt.query) || (/^\s*with\b/i.test(stmt.query) && /\b(insert|update|delete|merge)\b/i.test(noStrings))) throw new SkipError('bukan SELECT');
      const params = Math.max(0, ...[...stmt.query.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
      try {
        // extended protocol: a multi-statement string is rejected instead of executed
        await client.query({ text: `PREPARE dbc_explain AS ${stmt.query}`, queryMode: 'extended' } as pg.QueryConfig);
        const rows = await q(`EXPLAIN (FORMAT JSON, VERBOSE) EXECUTE dbc_explain${params ? `(${Array(params).fill('NULL').join(', ')})` : ''}`);
        return pgScans(rows[0]['QUERY PLAN']);
      } finally { await client.query('DEALLOCATE dbc_explain').catch(() => {}); }
    },

    async tables(): Promise<TableInfo[]> {
      const rows = await q(`SELECT n.nspname || '.' || c.relname AS "table", greatest(c.reltuples, 0)::float8 AS rows,
          coalesce((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '{}') AS columns
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`);
      return rows.map(r => ({ table: r.table, rows: Number(r.rows), columns: r.columns }));
    },

    async indexes(): Promise<IndexInfo[]> {
      return (await q(INDEXES_SQL)).map(({ table, name, columns, unique, primary }) => ({ table, name, columns, unique, primary }));
    },

    async tableScans(limit: number): Promise<TableScanStat[]> {
      const rows = await q(`SELECT schemaname || '.' || relname AS "table", seq_scan, seq_tup_read, n_live_tup FROM pg_stat_user_tables
        WHERE seq_scan > 0 AND n_live_tup > $1 ORDER BY seq_tup_read DESC LIMIT $2`, [MIN_TABLE_ROWS, limit]);
      return rows.map(r => ({ table: r.table, scans: Number(r.seq_scan), rowsRead: Number(r.seq_tup_read), liveRows: Number(r.n_live_tup) }));
    },

    async unindexedForeignKeys(): Promise<ForeignKeyIssue[]> {
      // indkey is 0-based int2vector; going through text gives a 1-based array comparable to conkey.
      return q(`SELECT n.nspname || '.' || t.relname AS "table", c.conname AS "constraint",
          (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'f' AND NOT EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid = c.conrelid
          AND ix.indisvalid AND ix.indpred IS NULL AND cardinality(c.conkey) <= ix.indnkeyatts
          AND (string_to_array(ix.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] = c.conkey)
        ORDER BY 1, 2`);
    },

    async unusedIndexes(limit: number): Promise<IndexInfo[]> {
      const rows = await q(`SELECT x.* FROM (${INDEXES_SQL}) x JOIN pg_stat_user_indexes s ON s.indexrelid = x.oid
        WHERE s.idx_scan = 0 AND NOT x."unique" AND NOT x."primary" ORDER BY pg_relation_size(x.oid) DESC LIMIT $1`, [limit]);
      return rows.map(({ table, name, columns, unique, primary }) => ({ table, name, columns, unique, primary }));
    },

    async longRunning(minSeconds: number): Promise<RunningQuery[]> {
      const rows = await q(`SELECT pid, usename, extract(epoch FROM now() - query_start) AS seconds, state, query FROM pg_stat_activity
        WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid() AND backend_type = 'client backend'
          AND now() - query_start > make_interval(secs => $1::float8) ORDER BY query_start`, [minSeconds]);
      return rows.map(r => ({ pid: r.pid, user: r.usename, seconds: Number(r.seconds), state: r.state, query: r.query }));
    },

    async lockWaits(): Promise<LockWait[]> {
      const rows = await q(`SELECT a.pid AS waiting_pid, a.query AS waiting_query, bp.pid AS blocking_pid, b.query AS blocking_query,
          extract(epoch FROM now() - a.query_start) AS seconds
        FROM pg_stat_activity a CROSS JOIN LATERAL unnest(pg_blocking_pids(a.pid)) AS bp(pid)
        LEFT JOIN pg_stat_activity b ON b.pid = bp.pid WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'`);
      return rows.map(r => ({ waitingPid: r.waiting_pid, waitingQuery: r.waiting_query, blockingPid: r.blocking_pid, blockingQuery: r.blocking_query, seconds: Number(r.seconds) }));
    },

    describeError: err => (err as { code?: string } | null)?.code === '42501'
      ? 'Hak akses kurang. Jalankan: GRANT pg_read_all_stats TO <user>;' : null,

    close: () => client.end(),
  };
}
