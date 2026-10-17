import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { MIN_TABLE_ROWS, SkipError } from '../types.js';
import type { DbAdapter, ForeignKeyIssue, IndexInfo, LockWait, RunningQuery, ServerInfo, StatementStat, TableInfo, TableScanStat } from '../types.js';
import type { MysqlOptions } from '../connection.js';
import { mysqlScans } from '../plan.js';
import { normalizeDigest } from '../sql-usage.js';
import { hasPlaceholder } from '../mask.js';
import { MYSQL_STATIC } from '../config.js';
import type { ServerFacts, Setting } from '../config.js';

const MY_VARS = ['innodb_buffer_pool_size', 'key_buffer_size', 'aria_pagecache_buffer_size', 'sort_buffer_size', 'join_buffer_size', 'read_buffer_size',
  'read_rnd_buffer_size', 'thread_stack', 'binlog_cache_size', 'max_connections', 'wait_timeout', 'interactive_timeout', 'performance_schema',
  'slow_query_log', 'long_query_time', 'innodb_buffer_pool_chunk_size', 'innodb_buffer_pool_instances'];
const MY_BYTES = new Set(['innodb_buffer_pool_size', 'key_buffer_size', 'aria_pagecache_buffer_size', 'sort_buffer_size', 'join_buffer_size',
  'read_buffer_size', 'read_rnd_buffer_size', 'thread_stack', 'binlog_cache_size', 'innodb_buffer_pool_chunk_size']);
const inList = (xs: string[]) => xs.map(x => `'${x}'`).join(',');

const PS_HINT = `performance_schema belum aktif. Cara mengaktifkan:
- Server sendiri: tambahkan performance_schema = ON di my.cnf, lalu restart.
- AWS RDS: ubah parameter group performance_schema = 1, lalu reboot.
- Google Cloud SQL: nyalakan flag performance_schema.
- Catatan: di MariaDB, nilai default-nya mati.`;
const isOn = (v?: string) => /^(on|1|true|yes)$/i.test(v ?? '');
// True only for a global (ON *.*) grant of PROCESS or ALL PRIVILEGES; database-level grants do not show other users' threads.
export const hasGlobalProcess = (grants: string[]) => grants.some(g => {
  const m = /^GRANT\s+(.+?)\s+ON\s+\*\.\*\s+TO\b/is.exec(g);
  return !!m && /\bPROCESS\b|\bALL(\s+PRIVILEGES)?\b/i.test(m[1]);
});
const NO_SYS = 'schema sys tidak tersedia';

export async function createMysqlAdapter(opts: MysqlOptions): Promise<DbAdapter> {
  // multipleStatements stays off: EXPLAIN of a sample containing ';' must not run a second statement.
  const conn = await mysql.createConnection({ connectTimeout: 10000, ...opts, multipleStatements: false });
  const q = async (sql: string, params: unknown[] = []) => (await conn.query<RowDataPacket[]>(sql, params))[0];
  let version: string, mariadb: boolean, hasSample: boolean, maxSqlText: number;
  try {
    version = (await q('SELECT VERSION() AS v'))[0].v;
    mariadb = /mariadb/i.test(version);
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query(mariadb ? 'SET SESSION max_statement_time = 5' : 'SET SESSION max_execution_time = 5000');
    hasSample = (await q(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'performance_schema'
      AND TABLE_NAME = 'events_statements_summary_by_digest' AND COLUMN_NAME = 'QUERY_SAMPLE_TEXT'`)).length > 0;
    maxSqlText = Number((await q('SELECT @@performance_schema_max_sql_text_length AS n'))[0].n);
    if (!Number.isFinite(maxSqlText)) maxSqlText = 0;   // fail closed: every sample counts as truncated
  } catch (err) { await conn.end().catch(() => {}); throw err; }
  const canProcess = async () => hasGlobalProcess((await q('SHOW GRANTS')).map(r => String(Object.values(r)[0])));
  const hasSys = async () => (await q(`SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'sys'`)).length > 0;
  const indexes = async (): Promise<IndexInfo[]> => {
    const rows = await q(`SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS tbl, INDEX_NAME AS name, COLUMN_NAME AS col, NON_UNIQUE AS non_unique
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
    const out = new Map<string, IndexInfo>();
    for (const r of rows) {
      const key = `${r.tbl}\0${r.name}`;
      const ix: IndexInfo = out.get(key) ?? { table: r.tbl, name: r.name, columns: [], unique: Number(r.non_unique) === 0, primary: r.name === 'PRIMARY' };
      if (r.col) ix.columns.push(r.col);   // functional index parts have a NULL column
      out.set(key, ix);
    }
    return [...out.values()];
  };

  return {
    dialect: 'mysql', defaultSchema: opts.database,

    async info(): Promise<ServerInfo> {
      const warnings: string[] = [];
      if (mariadb) warnings.push('MariaDB: dukungan terbatas. Saran index hanya berdasarkan analisa teks (keyakinan rendah).');
      if (/^5\./.test(version)) warnings.push('MySQL 5.7 sudah end-of-life dan tidak didukung resmi; sebagian analisa dilewati.');
      try {
        if (!await canProcess()) warnings.push('Tanpa privilege PROCESS, daftar query yang sedang jalan hanya berisi query milik user ini.');
      } catch { /* optional metadata */ }
      let statsSince: Date | null = null;
      try {
        const uptime = Number((await q(`SHOW GLOBAL STATUS LIKE 'Uptime'`))[0]?.Value);
        if (Number.isFinite(uptime)) statsSince = new Date(Date.now() - uptime * 1000);
      } catch { /* optional metadata */ }
      return { dialect: 'mysql', flavor: mariadb ? 'mariadb' : 'mysql', version, database: opts.database, statsSince, warnings };
    },

    async statements(): Promise<StatementStat[]> {
      if (!Number((await q('SELECT @@performance_schema AS p'))[0].p)) throw new SkipError(PS_HINT);
      const rows = await q(`SELECT CONCAT(SCHEMA_NAME, ':', DIGEST) AS \`key\`, DIGEST_TEXT AS digest_text, ${hasSample ? 'QUERY_SAMPLE_TEXT' : 'NULL'} AS sample,
          COUNT_STAR AS calls, SUM_TIMER_WAIT / 1e9 AS total_ms, AVG_TIMER_WAIT / 1e9 AS mean_ms,
          SUM_ROWS_SENT AS \`rows\`, SUM_ROWS_EXAMINED AS rows_examined, SUM_NO_INDEX_USED AS no_index_used
        FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME = DATABASE() AND DIGEST IS NOT NULL`);
      return rows.map(r => ({ key: r.key, query: normalizeDigest(r.digest_text), ...(r.sample ? { sample: r.sample } : {}),
        calls: Number(r.calls), totalMs: Number(r.total_ms), meanMs: Number(r.mean_ms), rows: Number(r.rows),
        rowsExamined: Number(r.rows_examined), noIndexUsed: Number(r.no_index_used) }));
    },

    async explain(stmt: StatementStat) {
      if (mariadb) throw new SkipError('MariaDB: rencana eksekusi tidak dipakai (dukungan terbatas)');
      const sample = stmt.sample;
      if (!sample) throw new SkipError('tidak ada contoh query (QUERY_SAMPLE_TEXT)');
      // the limit is in bytes; the server may trim up to 3 bytes at a utf8mb4 boundary
      if (Buffer.byteLength(sample, 'utf8') >= maxSqlText - 3) throw new SkipError('contoh query terpotong');
      if (hasPlaceholder(sample, 'mysql')) throw new SkipError('contoh query memakai placeholder (prepared statement)');
      // Conservative: a WITH mentioning any DML keyword (even in a string) is refused; over-rejection is fine.
      if (!/^\s*(select|with)\b/i.test(sample) || (/^\s*with\b/i.test(sample) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sample))) throw new SkipError('bukan SELECT');
      // text protocol on purpose: the sample contains literals, and multipleStatements is off.
      const rows = await q(`EXPLAIN FORMAT=JSON ${sample}`);
      const json = Object.values(rows[0])[0];
      return mysqlScans(typeof json === 'string' ? JSON.parse(json) : json);
    },

    async tables(): Promise<TableInfo[]> {
      const rows = await q(`SELECT TABLE_NAME AS name, TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`);
      const cols = await q(`SELECT TABLE_NAME AS name, COLUMN_NAME AS col FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
      return rows.map(r => ({ table: `${opts.database}.${r.name}`, rows: Number(r.n ?? 0), columns: cols.filter(c => c.name === r.name).map(c => c.col) }));
    },

    indexes,

    async tableScans(limit: number): Promise<TableScanStat[]> {
      if (!await hasSys()) throw new SkipError(NO_SYS);
      const rows = await q(`SELECT CONCAT(s.object_schema, '.', s.object_name) AS tbl, s.rows_full_scanned AS scanned, t.TABLE_ROWS AS live
        FROM sys.schema_tables_with_full_table_scans s
        JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.object_schema AND t.TABLE_NAME = s.object_name
        WHERE s.object_schema = DATABASE() AND t.TABLE_ROWS > ? ORDER BY s.rows_full_scanned DESC LIMIT ?`, [MIN_TABLE_ROWS, limit]);
      return rows.map(r => ({ table: r.tbl, rowsRead: Number(r.scanned), liveRows: Number(r.live) }));
    },

    async unindexedForeignKeys(): Promise<ForeignKeyIssue[]> {
      throw new SkipError('Tidak relevan untuk MySQL/MariaDB: InnoDB otomatis membuat index untuk foreign key.');
    },

    async unusedIndexes(limit: number): Promise<IndexInfo[]> {
      if (!await hasSys()) throw new SkipError(NO_SYS);
      const unused = new Set((await q(`SELECT object_schema, object_name, index_name FROM sys.schema_unused_indexes WHERE object_schema = DATABASE()`))
        .map(r => `${r.object_schema}.${r.object_name}\0${r.index_name}`));
      return (await indexes()).filter(i => !i.unique && unused.has(`${i.table}\0${i.name}`)).slice(0, limit);
    },

    async longRunning(minSeconds: number): Promise<RunningQuery[]> {
      const rows = await q(`SELECT ID AS pid, USER AS user, TIME AS seconds, COALESCE(STATE, COMMAND) AS state, INFO AS query
        FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND ID <> CONNECTION_ID() AND DB = DATABASE() AND TIME > ? ORDER BY TIME DESC`, [minSeconds]);
      return rows.map(r => ({ pid: Number(r.pid), user: r.user, seconds: Number(r.seconds), state: r.state, query: r.query ?? '' }));
    },

    async lockWaits(): Promise<LockWait[]> {
      if (!await hasSys()) throw new SkipError(NO_SYS);
      const rows = await q(`SELECT waiting_pid, waiting_query, blocking_pid, blocking_query, wait_age_secs FROM sys.innodb_lock_waits WHERE locked_table LIKE CONCAT('\`', DATABASE(), '\`.%')`);
      return rows.map(r => ({ waitingPid: Number(r.waiting_pid), waitingQuery: r.waiting_query, blockingPid: Number(r.blocking_pid), blockingQuery: r.blocking_query, seconds: Number(r.wait_age_secs) }));
    },

    async serverConfig(): Promise<ServerFacts> {
      const settings: Record<string, Setting> = {};
      for (const r of await q(`SHOW GLOBAL VARIABLES WHERE Variable_name IN (${inList(MY_VARS)})`))
        settings[r.Variable_name] = { value: String(r.Value), restart: MYSQL_STATIC.has(r.Variable_name),
          ...(MY_BYTES.has(r.Variable_name) && Number.isFinite(Number(r.Value)) ? { bytes: Number(r.Value) } : {}) };
      const status: Record<string, number> = {};
      for (const r of await q(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Max_used_connections','Connection_errors_max_connections')`))
        status[r.Variable_name] = Number(r.Value);
      const groups = (await q(`SELECT USER AS u, DB AS d, SUBSTRING_INDEX(HOST, ':', 1) AS h, COMMAND AS c, COUNT(*) AS n, SUM(COMMAND = 'Sleep' AND TIME > 600) AS idle_long
        FROM information_schema.PROCESSLIST GROUP BY USER, DB, h, COMMAND`)).map(r => ({
        ...(r.d ? { database: r.d } : {}), user: r.u ?? '', app: r.h ?? '', state: r.c ?? '', count: Number(r.n), idleLong: Number(r.idle_long) }));
      const partial = !await canProcess().catch(() => false);
      let digestConsumer = false;
      if (isOn(settings.performance_schema?.value))
        try { digestConsumer = (await q(`SELECT ENABLED FROM performance_schema.setup_consumers WHERE NAME = 'statements_digest'`))[0]?.ENABLED === 'YES'; }
        catch { /* missing privilege: leave false */ }
      return { flavor: mariadb ? 'mariadb' : 'mysql', version: version.match(/^\d+(\.\d+)*/)?.[0] ?? version, settings,
        connections: { max: Number(settings.max_connections?.value ?? 0), reserved: 0, used: status.Threads_connected ?? 0,
          peak: status.Max_used_connections, rejected: status.Connection_errors_max_connections, partial, groups },
        digestConsumer };
    },

    describeError: err => [1142, 1143, 1227, 1044].includes((err as { errno?: number } | null)?.errno ?? 0)
      ? 'Hak akses kurang. Jalankan: GRANT SELECT ON performance_schema.* TO <user>; GRANT SELECT ON sys.* TO <user>; GRANT PROCESS ON *.* TO <user>;' : null,

    close: () => conn.end(),
  };
}
