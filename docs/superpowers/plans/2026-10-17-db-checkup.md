# db-checkup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI `db-checkup <url>` yang konek ke satu database Postgres/MySQL/MariaDB, membaca statistik bawaan, lalu menampilkan query paling lambat, saran `CREATE INDEX`, masalah index level tabel, dan kondisi saat ini, di terminal dan opsional ke file Markdown.

**Architecture:** Dua adapter (`postgres`, `mysql`) mengimplementasikan satu interface `DbAdapter` yang hanya membaca data. Semua logika lain adalah fungsi murni yang bisa dites tanpa database: masking SQL, diff snapshot, ekstraksi kolom dari SQL, pembacaan rencana `EXPLAIN`, dan saran index. `analyze()` menjalankan semua analisa dengan isolasi error per analisa dan menghasilkan `AnalysisResult`. `buildReport()` mengubahnya menjadi `Report` generik (section + block), lalu ada dua renderer: terminal dan Markdown.

**Tech Stack:** Node.js ≥ 20.12, TypeScript (strict, ESM), `pg`, `mysql2`, `node-sql-parser`. Test: `node:test` + `tsx`. CLI args: `node:util` `parseArgs`. Warna: `node:util` `styleText`. Integration test: Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-17-db-checkup-design.md`

**Penyimpangan kecil dari spec (keputusan rencana):** spec bagian 9.2 memakai `EXPLAIN (GENERIC_PLAN)` untuk PG16+ dan `PREPARE` + `force_generic_plan` untuk PG12–15. Rencana ini memakai jalur `PREPARE` untuk **semua** versi Postgres. Hasilnya setara, dan hanya ada satu jalur kode.

## Global Constraints

- Node `>=20.12` (`engines` di `package.json`). ESM (`"type": "module"`). TypeScript `strict: true`.
- Dependency runtime hanya `pg`, `mysql2`, `node-sql-parser`. Dev: `typescript`, `tsx`, `@types/node`, `@types/pg`.
- Tools tidak pernah menulis ke database. Larangan: `EXPLAIN ANALYZE`, `CREATE`, `ALTER`, `DROP`, reset statistik, `CREATE EXTENSION`. Session dibuat read-only.
- Batas waktu per query tools: Postgres `statement_timeout = 5000` (ms) dan `lock_timeout = 2000` (ms). MySQL `max_execution_time = 5000` (ms). MariaDB `max_statement_time = 5` (detik).
- Tools memakai satu koneksi saja.
- Konstanta (di `src/types.ts`): `MIN_TABLE_ROWS = 10000`, `LONG_RUNNING_SECONDS = 5`, `DEFAULT_TOP = 10`, `QUERY_PREVIEW_CHARS = 200`.
- Semua teks report memakai Bahasa Indonesia. Angka diformat dengan `Intl.NumberFormat('id-ID')`.
- Password di connection string selalu disamarkan, tanpa pengecualian. Literal di dalam query disamarkan kecuali ada flag `--no-mask`.
- Template saran index:
  - Postgres: `CREATE INDEX CONCURRENTLY <nama> ON <tabel> (<kolom>);`
  - MySQL: `CREATE INDEX <nama> ON <tabel> (<kolom>) ALGORITHM=INPLACE, LOCK=NONE;`
- Nama tabel internal selalu `schema.tabel`: schema Postgres (default `public`), atau nama database untuk MySQL. Semua perbandingan identifier dilakukan case-insensitive.

## Review Focus

1. **Contoh query MySQL yang terpotong** (kutip tidak ditutup, misalnya `VALUES ('abc`). Masker harus menyamarkan sampai akhir teks dan tidak boleh membocorkan sisanya. Tes ada di Task 2.
2. **SQL dengan `|` atau baris baru di dalam sel tabel Markdown** (contoh: `a || b` di Postgres). Karakter itu harus di-escape supaya tabel tidak rusak. Tes ada di Task 7.
3. **Statistik direset di antara dua snapshot `--watch`** (nilai kedua lebih kecil). Selisih harus memakai nilai kedua, bukan angka negatif. Tes ada di Task 3.
4. **Pesan error database yang mengandung nilai literal** (contoh: `invalid input syntax ... 'budi@x.com'`). Pesan ini disamarkan sebelum masuk report. Tes ada di Task 8.
5. **`DIGEST_TEXT` MySQL berisi `IN (...)`.** Parser SQL gagal membacanya, jadi teks perlu dinormalisasi dulu. Tes ada di Task 4.

---

### Task 1: Scaffold proyek + parsing connection URL

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/connection.ts`
- Test: `test/connection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MysqlOptions { host: string; port: number; user: string; password: string; database: string; ssl?: { rejectUnauthorized?: boolean } }
  export type ConnectionConfig =
    | { dialect: 'postgres'; url: string; database: string }
    | { dialect: 'mysql'; database: string; mysql: MysqlOptions };
  export function parseConnectionUrl(url: string): ConnectionConfig;
  export function redactUrl(url: string): string;
  ```

- [ ] **Step 1: Inisialisasi repo dan scaffold**

  Jalankan `git init`. Isi `package.json`:
  - `"name": "db-checkup"`, `"type": "module"`, `"bin": { "db-checkup": "dist/cli.js" }`, `"engines": { "node": ">=20.12" }`, `"files": ["dist"]`
  - scripts:
    - `"build": "tsc"`
    - `"test": "node --import tsx --test test/*.test.ts"`
    - `"test:it": "DB_CHECKUP_IT=1 node --import tsx --test --test-concurrency=1 test/integration/*.test.ts"`

  Isi `tsconfig.json`: `target ES2022`, `module NodeNext`, `strict`, `outDir dist`, `rootDir src`. `.gitignore` berisi `node_modules`, `dist`. Lalu install dependency dari Global Constraints.

- [ ] **Step 2: Tulis tes yang gagal**

```ts
test('postgres url kept as-is', () => {
  const c = parseConnectionUrl('postgresql://app:s%40cret@db.local:5433/shop?sslmode=require');
  assert.deepEqual(c, { dialect: 'postgres', url: 'postgresql://app:s%40cret@db.local:5433/shop?sslmode=require', database: 'shop' });
});
test('postgres without database falls back to user', () =>
  assert.equal(parseConnectionUrl('postgres://app@h').database, 'app'));
test('mysql url decoded, default port, ssl=true', () =>
  assert.deepEqual(parseConnectionUrl('mysql://root:p%23ss@10.0.0.5/shop?ssl=true'), {
    dialect: 'mysql', database: 'shop',
    mysql: { host: '10.0.0.5', port: 3306, user: 'root', password: 'p#ss', database: 'shop', ssl: {} } }));
test('mysql ssl=skip-verify', () =>
  assert.deepEqual((parseConnectionUrl('mysql://u@h/db?ssl=skip-verify') as any).mysql.ssl, { rejectUnauthorized: false }));
test('mysql without database throws', () =>
  assert.throws(() => parseConnectionUrl('mysql://root@h/'), /nama database/));
test('unknown scheme throws', () =>
  assert.throws(() => parseConnectionUrl('redis://h'), /postgres:\/\/ atau mysql:\/\//));
test('redactUrl hides password only', () => {
  assert.equal(redactUrl('postgres://app:secret@h/db'), 'postgres://app:***@h/db');
  assert.equal(redactUrl('mysql://app@h/db'), 'mysql://app@h/db');
});
```

- [ ] **Step 3: Jalankan `npm test`. Hasil yang diharapkan: FAIL (modul belum ada).**
- [ ] **Step 4: Implementasikan `src/connection.ts`** memakai `new URL()`. Scheme yang diterima: `postgres:`, `postgresql:`, `mysql:`. URL yang tidak valid dilempar sebagai `Error` dengan pesan berbahasa Indonesia, dan pesan itu tidak boleh memuat URL aslinya.
- [ ] **Step 5: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 6: Commit** `feat: scaffold project and connection url parsing`

---

### Task 2: Masking SQL

**Files:**
- Create: `src/mask.ts`
- Test: `test/mask.test.ts`

**Interfaces:**
- Consumes: `Dialect` (`'postgres' | 'mysql'`). Definisikan di `src/types.ts` (dibuat di task ini, isinya dilengkapi di Task 3).
- Produces: `maskSql(sql: string, dialect: Dialect): string` dan `hasPlaceholder(sql: string, dialect: Dialect): boolean`

- [ ] **Step 1: Tulis tes yang gagal**

```ts
const m = maskSql;
test('strings and numbers', () =>
  assert.equal(m("SELECT * FROM users WHERE email = 'budi@x.com' AND id = 42", 'mysql'), 'SELECT * FROM users WHERE email = ? AND id = ?'));
test('doubled and backslash quotes', () => {
  assert.equal(m("WHERE name = 'O''Brien'", 'postgres'), 'WHERE name = ?');
  assert.equal(m("WHERE a = 'it\\'s' AND b = 1", 'mysql'), 'WHERE a = ? AND b = ?');
});
test('identifiers untouched', () => {
  assert.equal(m('SELECT t1.col_2 FROM "Orders" o WHERE o.v = 3.5', 'postgres'), 'SELECT t1.col_2 FROM "Orders" o WHERE o.v = ?');
  assert.equal(m('SELECT `col1` FROM `t2`', 'mysql'), 'SELECT `col1` FROM `t2`');
});
test('mysql double quotes are strings', () => assert.equal(m('WHERE a = "secret"', 'mysql'), 'WHERE a = ?'));
test('pg dollar quotes masked, params kept', () => assert.equal(m('SELECT $tag$secret$tag$, $1', 'postgres'), 'SELECT ?, $1'));
test('unterminated quote masks to end', () => assert.equal(m("INSERT INTO t VALUES ('abc", 'mysql'), 'INSERT INTO t VALUES (?'));
test('comments dropped, whitespace collapsed', () => assert.equal(m('SELECT 1 -- token=abc\nFROM   t /* x */', 'postgres'), 'SELECT ? FROM t'));
test('hasPlaceholder', () => {
  assert.equal(hasPlaceholder("SELECT * FROM t WHERE a = ?", 'mysql'), true);
  assert.equal(hasPlaceholder("SELECT * FROM t WHERE a = 'what?'", 'mysql'), false);
});
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan tokenizer satu lintasan di `src/mask.ts`.**

  Aturan per token:
  - String `'…'` diganti `?`. Escape `''` dan `\'` berlaku di kedua dialect, karena kalau ragu lebih baik menyamarkan terlalu banyak.
  - `"…"` diganti `?` hanya di MySQL. Di Postgres `"…"` adalah identifier dan dibiarkan.
  - Dollar quote `$tag$…$tag$` di Postgres diganti `?`.
  - Angka diganti `?` kalau tidak didahului karakter identifier `[A-Za-z0-9_$]`. Karena `$` termasuk, `$1` tetap utuh. Ini termasuk `3.5`, `1e10`, dan `0xFF`.
  - Komentar `--` dan `/* */` dihapus.
  - Kutip yang tidak ditutup: semua teks sampai akhir diganti `?`.
  - Hasil akhir: whitespace dirapatkan lalu di-trim.

  `hasPlaceholder` memakai tokenizer yang sama dan mencari `?` di luar string.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: sql literal masking`

---

### Task 3: Tipe bersama + statistik (ranking, diff, filter)

**Files:**
- Modify: `src/types.ts`
- Create: `src/stats.ts`
- Test: `test/stats.test.ts`

**Interfaces:**
- Produces (`src/types.ts`). Semua task berikutnya memakai nama-nama ini:
  ```ts
  export type Dialect = 'postgres' | 'mysql';
  export const MIN_TABLE_ROWS = 10000, LONG_RUNNING_SECONDS = 5, DEFAULT_TOP = 10, QUERY_PREVIEW_CHARS = 200;
  export interface ServerInfo { dialect: Dialect; flavor: 'postgres' | 'mysql' | 'mariadb'; version: string; database: string; statsSince: Date | null; warnings: string[] }
  export interface StatementStat { key: string; query: string; sample?: string; calls: number; totalMs: number; meanMs: number; rows: number; rowsExamined?: number; noIndexUsed?: number }
  export interface TableInfo { table: string; rows: number; columns: string[] }          // table = 'schema.name'
  export interface IndexInfo { table: string; name: string; columns: string[]; unique: boolean; primary: boolean }
  export interface PlanScan { table: string }                                             // 'schema.name', or alias/bare name (MySQL)
  export interface ColumnUsage { table: string; column: string; kind: 'eq' | 'range' | 'order' }
  export type Confidence = 'tinggi' | 'sedang' | 'rendah';
  export interface Suggestion { query: string; table: string; columns: string[]; confidence: Confidence; reason: string; sql: string }
  export interface SuggestionResult { items: Suggestion[]; skipped: { query: string; reason: string }[] }
  export interface TableScanStat { table: string; scans?: number; rowsRead: number; liveRows?: number }
  export interface ForeignKeyIssue { table: string; constraint: string; columns: string[] }
  export interface RunningQuery { pid: number; user: string; seconds: number; state: string; query: string }
  export interface LockWait { waitingPid: number; waitingQuery: string; blockingPid: number; blockingQuery: string | null; seconds: number }
  export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };
  export class SkipError extends Error {}   // "not enabled / not supported": message shown verbatim, never masked
  export interface DbAdapter {
    dialect: Dialect; defaultSchema: string;
    info(): Promise<ServerInfo>;
    statements(): Promise<StatementStat[]>;
    explain(stmt: StatementStat): Promise<PlanScan[]>;
    tables(): Promise<TableInfo[]>;
    indexes(): Promise<IndexInfo[]>;
    tableScans(limit: number): Promise<TableScanStat[]>;
    unindexedForeignKeys(): Promise<ForeignKeyIssue[]>;
    unusedIndexes(limit: number): Promise<IndexInfo[]>;
    longRunning(minSeconds: number): Promise<RunningQuery[]>;
    lockWaits(): Promise<LockWait[]>;
    describeError(err: unknown): string | null;   // privilege hint for access-denied errors
    close(): Promise<void>;
  }
  export interface AnalysisResult {
    connection: string; info: ServerInfo; watchSeconds?: number;
    current?: Outcome<StatementStat[]>; cumulative: Outcome<StatementStat[]>;
    suggestions: Outcome<SuggestionResult>;
    tableScans: Outcome<TableScanStat[]>; foreignKeys: Outcome<ForeignKeyIssue[]>; unusedIndexes: Outcome<IndexInfo[]>;
    running: Outcome<RunningQuery[]>; locks: Outcome<LockWait[]>;
  }
  ```
- Produces (`src/stats.ts`): `topByTotal(stats: StatementStat[], n: number): StatementStat[]`, `diffStatements(before: StatementStat[], after: StatementStat[]): StatementStat[]`, `isOwnOrSystemQuery(sql: string): boolean`

- [ ] **Step 1: Tulis tes yang gagal**

```ts
const s = (key: string, totalMs: number, calls = 1): StatementStat => ({ key, query: key, calls, totalMs, meanMs: totalMs / calls, rows: 0 });
test('topByTotal', () => assert.deepEqual(topByTotal([s('a', 5), s('b', 9), s('c', 1)], 2).map(x => x.key), ['b', 'a']));
test('diff: delta, new entry counted from zero', () => {
  const d = diffStatements([s('a', 100, 10)], [s('a', 160, 13), s('b', 7, 1)]);
  assert.deepEqual(d.find(x => x.key === 'a'), { ...s('a', 60, 3) });
  assert.equal(d.find(x => x.key === 'b')!.totalMs, 7);
});
test('diff: unchanged dropped', () => assert.deepEqual(diffStatements([s('a', 5)], [s('a', 5)]), []));
test('diff: reset between snapshots uses second value', () => {
  const [a] = diffStatements([s('a', 100, 10)], [s('a', 30, 2)]);
  assert.equal(a.totalMs, 30); assert.equal(a.calls, 2);
});
test('isOwnOrSystemQuery', () => {
  for (const q of ['EXPLAIN SELECT 1', 'SET statement_timeout = 5000', 'PREPARE x AS SELECT 1', 'DEALLOCATE x', 'SHOW server_version_num',
                   'SELECT * FROM pg_stat_statements', 'SELECT * FROM performance_schema.processlist', 'SELECT * FROM information_schema.TABLES',
                   'SELECT * FROM sys.innodb_lock_waits', 'SELECT oid FROM pg_catalog.pg_class'])
    assert.equal(isOwnOrSystemQuery(q), true, q);
  assert.equal(isOwnOrSystemQuery('SELECT * FROM orders WHERE customer_id = $1'), false);
});
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan `src/stats.ts`.**
  - Selisih dihitung untuk `calls`, `totalMs`, `rows`, `rowsExamined`, dan `noIndexUsed`. Untuk setiap field: kalau nilai kedua lebih kecil dari nilai pertama, pakai nilai kedua.
  - `meanMs = totalMs / calls`. Kalau `calls` 0, `meanMs = 0`.
  - Entri dengan `totalMs <= 0` dibuang.
  - `isOwnOrSystemQuery` cocok untuk statement yang diawali `EXPLAIN|SET|PREPARE|DEALLOCATE|SHOW|BEGIN|COMMIT|ROLLBACK`, atau yang menyebut `pg_catalog`, `pg_stat_`, `information_schema`, `performance_schema`, `sys.`, atau `mysql.`.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: shared types and statement stats helpers`

---

### Task 4: Ekstraksi pemakaian kolom dari SQL

**Files:**
- Create: `src/sql-usage.ts`
- Test: `test/sql-usage.test.ts`

**Interfaces:**
- Consumes: `Dialect`, `TableInfo`, `ColumnUsage`
- Produces:
  ```ts
  export class SqlParseError extends Error {}
  export function normalizeDigest(digest: string): string;   // MySQL "IN (...)" -> "IN (?)"
  export function extractColumnUsage(sql: string, dialect: Dialect, defaultSchema: string, tables: TableInfo[]):
    { aliases: Record<string, string>; usage: ColumnUsage[] };   // aliases: alias AND bare name -> 'schema.table'
  ```

- [ ] **Step 1: Tulis tes yang gagal**

```ts
const pgTables: TableInfo[] = [
  { table: 'public.orders', rows: 50000, columns: ['id', 'customer_id', 'status', 'created_at'] },
  { table: 'public.customers', rows: 20000, columns: ['id', 'email'] }];
test('eq, range, order with alias', () => {
  const r = extractColumnUsage('SELECT * FROM orders o WHERE o.customer_id = $1 AND created_at > $2 ORDER BY o.created_at DESC', 'postgres', 'public', pgTables);
  assert.deepEqual(r.aliases, { o: 'public.orders', orders: 'public.orders' });
  assert.deepEqual(r.usage, [
    { table: 'public.orders', column: 'customer_id', kind: 'eq' },
    { table: 'public.orders', column: 'created_at', kind: 'range' },
    { table: 'public.orders', column: 'created_at', kind: 'order' }]);
});
test('join ON is eq on both sides, unqualified column resolved via table columns', () =>
  assert.deepEqual(extractColumnUsage('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE email = $1', 'postgres', 'public', pgTables).usage, [
    { table: 'public.customers', column: 'id', kind: 'eq' },
    { table: 'public.orders', column: 'customer_id', kind: 'eq' },
    { table: 'public.customers', column: 'email', kind: 'eq' }]));
test('ambiguous unqualified column skipped', () =>
  assert.ok(!extractColumnUsage('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE id = $1', 'postgres', 'public', pgTables)
    .usage.some(u => u.kind === 'eq' && u.column === 'id' && u.table === 'public.orders')));
test('mysql digest with IN (...)', () => {
  const t: TableInfo[] = [{ table: 'shop.orders', rows: 50000, columns: ['status', 'customer_id'] }];
  const sql = normalizeDigest('SELECT * FROM `orders` WHERE `status` IN (...) AND `customer_id` = ?');
  assert.deepEqual(extractColumnUsage(sql, 'mysql', 'shop', t).usage, [
    { table: 'shop.orders', column: 'status', kind: 'eq' },
    { table: 'shop.orders', column: 'customer_id', kind: 'eq' }]);
});
test('unparseable throws SqlParseError', () =>
  assert.throws(() => extractColumnUsage('SELEC nonsense ((', 'postgres', 'public', pgTables), SqlParseError));
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan dengan `node-sql-parser`.**
  - Panggil `new Parser().astify(sql, { database: dialect === 'postgres' ? 'PostgresQL' : 'MySQL' })`. Pakai AST statement pertama.
  - Kumpulkan pemakaian kolom dari tiga tempat, dengan urutan ini: kondisi `ON` di `from[]`, lalu `where`, lalu `orderby`.
  - Jenis pemakaian:
    - `=` dan `IN` menjadi `eq`.
    - `<`, `>`, `<=`, `>=`, `BETWEEN`, dan `LIKE` menjadi `range`.
    - Kolom di `ORDER BY` menjadi `order`.
  - Buang pemakaian duplikat (kombinasi tabel + kolom + jenis yang sama).
  - Kolom tanpa prefix tabel dicari lewat `TableInfo.columns` dari tabel-tabel yang ada di `FROM`. Kalau kolom itu ada di tepat satu tabel, pakai tabel itu. Kalau tidak, kolom dilewati.
  - Untuk `UPDATE` dan `DELETE`, ambil kolom dari `where`.
  - Error apa pun dari parser dibungkus menjadi `SqlParseError`.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: extract column usage from sql`

---

### Task 5: Membaca rencana EXPLAIN

**Files:**
- Create: `src/plan.ts`
- Test: `test/plan.test.ts`

**Interfaces:**
- Produces: `pgScans(explainJson: unknown): PlanScan[]` (input berupa hasil `EXPLAIN (FORMAT JSON, VERBOSE)`), dan `mysqlScans(explainJson: unknown): PlanScan[]`

- [ ] **Step 1: Tulis tes yang gagal**

```ts
test('pg nested seq scan', () =>
  assert.deepEqual(pgScans([{ Plan: { 'Node Type': 'Nested Loop', Plans: [
    { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'public', Alias: 'o' },
    { 'Node Type': 'Index Scan', 'Relation Name': 'customers', Schema: 'public' }] } }]), [{ table: 'public.orders' }]));
test('mysql nested loop ALL', () =>
  assert.deepEqual(mysqlScans({ query_block: { nested_loop: [
    { table: { table_name: 'o', access_type: 'ALL' } }, { table: { table_name: 'c', access_type: 'eq_ref' } }] } }), [{ table: 'o' }]));
test('mysql under ordering_operation, derived ignored', () =>
  assert.deepEqual(mysqlScans({ query_block: { ordering_operation: { nested_loop: [
    { table: { table_name: 'orders', access_type: 'ALL' } }, { table: { table_name: '<derived2>', access_type: 'ALL' } }] } } }), [{ table: 'orders' }]));
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan dengan penelusuran rekursif semua objek dan array.**
  - Postgres: node dengan `'Node Type' === 'Seq Scan'` menjadi `${Schema}.${Relation Name}`.
  - MySQL: objek dengan `access_type === 'ALL'` dan `table_name` yang tidak diawali `<`.
  - Buang hasil duplikat.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: find full table scans in explain plans`

---

### Task 6: Saran index

**Files:**
- Create: `src/suggest.ts`
- Test: `test/suggest.test.ts`

**Interfaces:**
- Consumes: `extractColumnUsage` (Task 4), dan tipe dari Task 3.
- Produces:
  ```ts
  export function suggestIndexes(input: { query: string; dialect: Dialect; defaultSchema: string; scans: PlanScan[] | null; noPlanReason?: string;
                                          tables: TableInfo[]; indexes: IndexInfo[] }): Omit<Suggestion, 'query'>[];   // throws SqlParseError
  export function createIndexSql(dialect: Dialect, table: string, columns: string[], defaultSchema: string): string;
  export function indexName(table: string, columns: string[]): string;
  ```

- [ ] **Step 1: Tulis tes yang gagal**

```ts
const tables: TableInfo[] = [{ table: 'public.orders', rows: 50000, columns: ['id', 'customer_id', 'status', 'created_at'] }];
const pk: IndexInfo = { table: 'public.orders', name: 'orders_pkey', columns: ['id'], unique: true, primary: true };
const base = { query: 'SELECT * FROM orders WHERE customer_id = $1 AND created_at > $2 ORDER BY created_at', dialect: 'postgres' as const,
               defaultSchema: 'public', scans: [{ table: 'public.orders' }], tables, indexes: [pk] };
test('full scan + eq -> tinggi', () => {
  const [s] = suggestIndexes(base);
  assert.deepEqual(s.columns, ['customer_id', 'created_at']);
  assert.equal(s.confidence, 'tinggi');
  assert.equal(s.sql, 'CREATE INDEX CONCURRENTLY idx_orders_customer_id_created_at ON orders (customer_id, created_at);');
  assert.match(s.reason, /Seq Scan pada `orders` \(50\.000 baris\)/);
});
test('full scan, range only -> sedang', () =>
  assert.equal(suggestIndexes({ ...base, query: 'SELECT * FROM orders WHERE created_at > $1' })[0].confidence, 'sedang'));
test('no plan -> rendah with reason', () => {
  const [s] = suggestIndexes({ ...base, scans: null, noPlanReason: 'contoh query terpotong' });
  assert.equal(s.confidence, 'rendah'); assert.match(s.reason, /contoh query terpotong/);
});
test('small table skipped', () => assert.deepEqual(suggestIndexes({ ...base, tables: [{ ...tables[0], rows: 500 }] }), []));
test('existing index with same leading columns skipped', () =>
  assert.deepEqual(suggestIndexes({ ...base, indexes: [pk, { ...pk, name: 'x', primary: false, unique: false, columns: ['customer_id', 'created_at', 'status'] }] }), []));
test('mysql alias from plan resolved, mysql template', () =>
  assert.equal(suggestIndexes({ query: 'SELECT * FROM `orders` `o` WHERE `o`.`customer_id` = ?', dialect: 'mysql', defaultSchema: 'shop',
    scans: [{ table: 'o' }], tables: [{ ...tables[0], table: 'shop.orders' }], indexes: [] })[0].sql,
    'CREATE INDEX idx_orders_customer_id ON orders (customer_id) ALGORITHM=INPLACE, LOCK=NONE;'));
test('quoting, non-default schema, name length', () => {
  assert.equal(createIndexSql('postgres', 'billing.OrderItems', ['userId'], 'public'),
    'CREATE INDEX CONCURRENTLY idx_orderitems_userid ON billing."OrderItems" ("userId");');
  assert.equal(createIndexSql('mysql', 'shop.orders', ['order'], 'shop'), 'CREATE INDEX idx_orders_order ON orders (`order`) ALGORITHM=INPLACE, LOCK=NONE;');
  assert.equal(indexName('public.t', ['a'.repeat(70)]).length, 63);
});
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan `src/suggest.ts`.**
  - **Tabel kandidat:**
    - Kalau `scans` ada: ambil tabel dari `scans`. Nama tabel diselesaikan lewat `aliases` dari `extractColumnUsage`. Kalau tidak ketemu, beri prefix `defaultSchema`.
    - Kalau `scans` null: ambil semua tabel yang punya pemakaian kolom.
    - Tabel dengan `rows <= MIN_TABLE_ROWS` dibuang.
  - **Urutan kolom:** semua kolom `eq` sesuai urutan muncul, lalu kolom `range` pertama, lalu kolom `order`. Buang duplikat.
  - **Lewati tabel** kalau daftar kolom saran adalah prefix dari kolom index yang sudah ada. Lewati juga kalau tidak ada kolom sama sekali.
  - **Keyakinan:**
    - `tinggi`: ada scan dan ada kolom `eq`.
    - `sedang`: ada scan, tapi tidak ada kolom `eq`.
    - `rendah`: tidak ada scan.
  - **Teks alasan:**
    - Ada scan: `` Seq Scan pada `<tabel>` (<rows id-ID> baris), filter `<kolom, …>` ``. Untuk MySQL, ganti `Seq Scan` dengan `Full table scan`.
    - Tidak ada scan: `` Tanpa rencana eksekusi (<noPlanReason>); tabel `<tabel>` <rows> baris, kolom `<kolom>` ``.
  - **Nama index:** `indexName` menghasilkan `idx_<tabel>_<kolom_digabung_dengan_>`. Huruf dijadikan kecil, karakter selain `[a-z0-9_]` diganti `_`, lalu dipotong sampai 63 karakter.
  - **Quoting identifier:**
    - Postgres: pakai `"…"` kalau nama tidak cocok dengan `/^[a-z_][a-z0-9_]*$/` atau termasuk kata reserved.
    - MySQL: pakai `` `…` `` kalau nama tidak cocok dengan `/^[A-Za-z_][A-Za-z0-9_]*$/` atau termasuk kata reserved.
    - Daftar kata reserved, beri komentar `// ponytail: small reserved list, extend when a real name breaks`: `order group user key index table select from where desc asc limit range rank check default references to window`.
    - Schema ditulis hanya kalau berbeda dari `defaultSchema`.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: rule-based index suggestions`

---

### Task 7: Report + renderer

**Files:**
- Create: `src/report.ts`, `src/render.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `AnalysisResult` dan tipe lain dari Task 3, `maskSql` dari Task 2.
- Produces:
  ```ts
  // report.ts
  export type Block = { kind: 'table'; headers: string[]; rows: string[][] } | { kind: 'code'; text: string } | { kind: 'text'; text: string; level?: 'info' | 'warn' };
  export interface Section { title: string; blocks: Block[] }
  export interface Report { title: string; sections: Section[] }
  export function buildReport(r: AnalysisResult, opts: { mask: boolean }): Report;
  export function formatMs(ms: number): string;      // 850 -> '850 ms', 12345 -> '12,3 s', 312000 -> '5,2 min'
  export function formatCount(n: number): string;    // 2100000 -> '2.100.000'
  // render.ts
  export function renderTerminal(r: Report, opts: { color: boolean }): string;
  export function renderMarkdown(r: Report): string;
  ```

- [ ] **Step 1: Tulis tes yang gagal.**

  Buat helper `sampleResult(overrides)` di file tes. Helper ini membuat `AnalysisResult` lengkap dengan semua `Outcome` bernilai `ok` dan kosong. Isi `connection` dengan `'postgres://app:***@h/shop'`. Isi `info` dengan Postgres 16.4, dan `statsSince` `2026-10-01`.

```ts
const titles = (r: Report) => r.sections.map(s => s.title);
test('section order with --watch', () =>
  assert.deepEqual(titles(buildReport(sampleResult({ watchSeconds: 60, current: { ok: true, value: [] } }), { mask: true })), [
    'Ringkasan', 'Query terberat saat ini (60 detik terakhir)', 'Query paling lambat (akumulasi)', 'Saran index',
    'Tabel yang sering di-scan penuh', 'Foreign key tanpa index', 'Index yang tidak pernah dipakai',
    'Query yang sedang jalan lama (> 5 detik)', 'Query yang saling mengunci']));
test('no current section without --watch', () =>
  assert.ok(!titles(buildReport(sampleResult({}), { mask: true })).some(t => t.startsWith('Query terberat saat ini'))));
test('empty section says Tidak ada temuan.', () =>
  assert.match(renderMarkdown(buildReport(sampleResult({}), { mask: true })), /## Index yang tidak pernah dipakai\n\nTidak ada temuan\./));
test('skipped outcome listed in Ringkasan and in its section', () => {
  const md = renderMarkdown(buildReport(sampleResult({ locks: { ok: false, reason: 'schema sys tidak tersedia' } }), { mask: true }));
  assert.match(md, /Dilewati — Query yang saling mengunci: schema sys tidak tersedia/);
  assert.match(md, /## Query yang saling mengunci\n\nDilewati: schema sys tidak tersedia/);
});
test('masking on all query text, off with mask:false', () => {
  const running = { ok: true as const, value: [{ pid: 1, user: 'app', seconds: 9, state: 'active', query: "SELECT * FROM u WHERE email = 'budi@x.com'" }] };
  assert.ok(!renderMarkdown(buildReport(sampleResult({ running }), { mask: true })).includes('budi@x.com'));
  assert.ok(renderMarkdown(buildReport(sampleResult({ running }), { mask: false })).includes('budi@x.com'));
});
test('markdown cells escape pipes and newlines', () => {
  const cumulative = { ok: true as const, value: [{ key: 'k', query: 'SELECT a || b\nFROM t', calls: 1, totalMs: 1, meanMs: 1, rows: 1 }] };
  assert.ok(renderMarkdown(buildReport(sampleResult({ cumulative }), { mask: true })).includes('SELECT a \\|\\| b FROM t'));
});
test('suggestion sql in code block + staging reminder', () => {
  const suggestions = { ok: true as const, value: { skipped: [], items: [{ query: 'SELECT 1', table: 'public.orders', columns: ['customer_id'], confidence: 'tinggi' as const, reason: 'r', sql: 'CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders (customer_id);' }] } };
  const md = renderMarkdown(buildReport(sampleResult({ suggestions }), { mask: true }));
  assert.match(md, /```sql\nCREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders \(customer_id\);\n```/);
  assert.match(md, /Uji index di staging dulu\. Setiap index menambah beban INSERT dan UPDATE\./);
});
test('no ANSI in markdown or uncolored terminal; ANSI when colored', () => {
  const rep = buildReport(sampleResult({ locks: { ok: false, reason: 'x' } }), { mask: true });
  assert.ok(!/\x1b\[/.test(renderMarkdown(rep)));
  assert.ok(!/\x1b\[/.test(renderTerminal(rep, { color: false })));
  assert.ok(/\x1b\[/.test(renderTerminal(rep, { color: true })));
});
test('formatting', () => {
  assert.equal(formatMs(850), '850 ms'); assert.equal(formatMs(12345), '12,3 s'); assert.equal(formatMs(312000), '5,2 min');
  assert.equal(formatCount(2100000), '2.100.000');
});
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan `src/report.ts` dan `src/render.ts`.**
  - **Judul report:** `Laporan db-checkup`. Di Markdown menjadi `# Laporan db-checkup`, dan setiap section menjadi `## <title>`.
  - **Isi Ringkasan:**
    - Tabel `Item | Nilai` dengan baris: `Database` (flavor + versi), `Nama database`, `Koneksi`, `Waktu analisa`, dan `Statistik dikumpulkan sejak`. Kalau `statsSince` null, isi dengan `tidak diketahui`.
    - Setelah tabel: setiap `info.warnings` sebagai teks `warn`.
    - Lalu satu baris per outcome yang gagal: `Dilewati — <judul section>: <reason>`.
  - **Kolom tabel query:** `# | Query | Eksekusi | Total | Rata-rata | Baris`. Kalau ada statement yang punya `rowsExamined`/`noIndexUsed` (MySQL), tambahkan kolom `Baris diperiksa` dan `Tanpa index`. Query di-mask lebih dulu (kalau `mask`), whitespace dirapatkan, lalu dipotong sampai `QUERY_PREVIEW_CHARS` dengan tambahan `…`.
  - **Saran index:** tabel `Query | Tabel | Kolom | Keyakinan | Alasan`. Setelah itu satu blok code berisi semua `sql`, lalu teks pengingat persis seperti di tes. `skipped` ditampilkan sebagai teks `Dilewati: <preview query> — <reason>`.
  - **Section lain:** kolom tabel bebas dan masuk akal. Query di section running dan locks juga di-mask.
  - **Renderer terminal:** judul section bold. Tabel dirender dengan kolom yang di-pad. Teks `warn` berwarna kuning lewat `styleText`. Warna hanya dipakai kalau `color: true`.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: report model with terminal and markdown renderers`

---

### Task 8: Orkestrasi `analyze()`

**Files:**
- Create: `src/analyze.ts`, `test/helpers.ts`
- Test: `test/analyze.test.ts`

**Interfaces:**
- Consumes: `DbAdapter`, `SkipError`, `topByTotal`, `diffStatements`, `isOwnOrSystemQuery`, `suggestIndexes`, `SqlParseError`, dan `maskSql`.
- Produces:
  ```ts
  export function analyze(adapter: DbAdapter, opts: { connection: string; top: number; watchSeconds?: number;
    sleep?: (ms: number) => Promise<void>; onTick?: (secondsLeft: number) => void }): Promise<AnalysisResult>;
  ```

- [ ] **Step 1: Tulis tes yang gagal.**

  Buat `export function fakeAdapter(overrides: Partial<DbAdapter>): DbAdapter` di `test/helpers.ts`, supaya bisa dipakai lagi di Task 11. Default-nya:
  - `dialect: 'postgres'`, `defaultSchema: 'public'`.
  - `info()` mengembalikan ServerInfo yang valid.
  - Semua method data mengembalikan `[]`.
  - `describeError` mengembalikan `null`, kecuali untuk `err.code === '42501'`: kembalikan `'Beri role pg_read_all_stats'`.

```ts
test('SkipError isolates one analysis', async () => {
  const r = await analyze(fakeAdapter({ statements: async () => { throw new SkipError('pg_stat_statements belum aktif'); } }), { connection: 'c', top: 10 });
  assert.deepEqual(r.cumulative, { ok: false, reason: 'pg_stat_statements belum aktif' });
  assert.equal(r.tableScans.ok, true);
});
test('generic DB error is masked', async () => {
  const r = await analyze(fakeAdapter({ tableScans: async () => { throw new Error("value 'budi@x.com' too long"); } }), { connection: 'c', top: 10 });
  assert.deepEqual(r.tableScans, { ok: false, reason: 'Gagal: value ? too long' });
});
test('access denied uses describeError', async () => {
  const r = await analyze(fakeAdapter({ lockWaits: async () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); } }), { connection: 'c', top: 10 });
  assert.deepEqual(r.locks, { ok: false, reason: 'Beri role pg_read_all_stats' });
});
test('own/system queries filtered, top applied', async () => {
  const st = (key: string, q: string, t: number) => ({ key, query: q, calls: 1, totalMs: t, meanMs: t, rows: 0 });
  const r = await analyze(fakeAdapter({ statements: async () => [st('1', 'EXPLAIN SELECT 1', 99), st('2', 'SELECT * FROM a', 5), st('3', 'SELECT * FROM b', 7)] }), { connection: 'c', top: 1 });
  assert.deepEqual(r.cumulative.ok && r.cumulative.value.map(s => s.key), ['3']);
});
test('watch: ticks each second then diffs', async () => {
  const snaps = [[{ key: 'a', query: 'SELECT 1 FROM t', calls: 10, totalMs: 100, meanMs: 10, rows: 0 }],
                 [{ key: 'a', query: 'SELECT 1 FROM t', calls: 13, totalMs: 160, meanMs: 12.3, rows: 0 }]];
  const slept: number[] = [], ticks: number[] = [];
  const r = await analyze(fakeAdapter({ statements: async () => snaps.shift()! }),
    { connection: 'c', top: 10, watchSeconds: 3, sleep: async ms => { slept.push(ms); }, onTick: s => ticks.push(s) });
  assert.deepEqual(slept, [1000, 1000, 1000]); assert.deepEqual(ticks, [3, 2, 1]);
  assert.equal(r.current!.ok && r.current!.value[0].totalMs, 60);
});
test('explain failure falls back to rendah; parse failure goes to skipped', async () => {
  const st = (key: string, q: string) => ({ key, query: q, calls: 1, totalMs: 10, meanMs: 10, rows: 0 });
  const r = await analyze(fakeAdapter({
    statements: async () => [st('1', 'SELECT * FROM orders WHERE customer_id = $1'), st('2', 'SELEC ((')],
    explain: async () => { throw new Error('could not determine data type of parameter $1'); },
    tables: async () => [{ table: 'public.orders', rows: 50000, columns: ['customer_id'] }] }), { connection: 'c', top: 10 });
  assert.ok(r.suggestions.ok);
  assert.equal(r.suggestions.value.items[0].confidence, 'rendah');
  assert.match(r.suggestions.value.items[0].reason, /could not determine data type/);
  assert.equal(r.suggestions.value.skipped[0].reason, 'SQL tidak bisa di-parse');
});
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan `analyze`.**
  - **Pembungkus error:** buat `run<T>(fn): Promise<Outcome<T>>`.
    - `SkipError`: `reason` adalah `err.message` apa adanya.
    - Error lain: kalau `adapter.describeError(err)` mengembalikan hint, pakai hint itu. Kalau tidak, `` `Gagal: ${maskSql(err.message, adapter.dialect)}` ``.
  - **Urutan kerja:**
    1. `info()`. Kalau gagal, lempar error (fatal).
    2. `statements()` sebagai snapshot 1. Buang query sistem dengan `isOwnOrSystemQuery`.
    3. Kalau `watchSeconds` diisi: ulangi `onTick(n)` lalu `sleep(1000)` dari `watchSeconds` sampai 1. Setelah itu ambil snapshot 2, lalu `current = topByTotal(diffStatements(s1, s2), top)`.
    4. `cumulative = topByTotal(snapshot terakhir, top)`.
  - **Saran index:**
    - Ambil `tables()` dan `indexes()` sekali. Kalau salah satunya gagal, seluruh `suggestions` menjadi `ok: false`.
    - Untuk setiap query unik (berdasarkan `key`) dari gabungan `current` dan `cumulative`: coba `explain`. Kalau gagal, `scans = null` dan `noPlanReason = err.message` (di-mask kecuali `SkipError`). Lalu panggil `suggestIndexes`.
    - `SqlParseError` masuk ke `skipped` dengan reason `SQL tidak bisa di-parse`.
  - **Analisa lain:** `tableScans(top)`, `unindexedForeignKeys()`, `unusedIndexes(top)`, `longRunning(LONG_RUNNING_SECONDS)`, dan `lockWaits()`, masing-masing dibungkus `run`.
  - `sleep` default: `node:timers/promises` `setTimeout`.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Commit** `feat: analysis orchestration with per-analysis isolation`

---

### Task 9: Adapter Postgres + integration test

**Files:**
- Create: `src/adapters/postgres.ts`, `docker-compose.yml`, `test/fixtures/pg-init.sql`, `test/integration/postgres.test.ts`

**Interfaces:**
- Consumes: `DbAdapter` dan tipe lain dari Task 3, `pgScans` (Task 5), `analyze` (Task 8), `SkipError`.
- Produces: `createPostgresAdapter(url: string): Promise<DbAdapter>`

- [ ] **Step 1: Siapkan Docker Compose.**
  - Service `pg12` (`postgres:12`, port `54312`) dan `pg16` (`postgres:16`, port `54316`). Keduanya: `command: postgres -c shared_preload_libraries=pg_stat_statements`, password `test`, init script `test/fixtures/pg-init.sql`.
  - Isi `pg-init.sql`:
    - `CREATE EXTENSION pg_stat_statements`.
    - Tabel `customers(id serial primary key, email text)` dengan 20.000 baris.
    - Tabel `orders(id serial primary key, customer_id int references customers(id), status text, created_at timestamptz)` dengan 50.000 baris dari `generate_series`.
    - `ANALYZE`.
- [ ] **Step 2: Tulis integration test yang gagal.**

  File dilewati kalau `process.env.DB_CHECKUP_IT !== '1'`. Untuk setiap URL di `['postgres://postgres:test@localhost:54312/postgres', 'postgres://postgres:test@localhost:54316/postgres']`:
  - Lewat client `pg` biasa (bukan adapter): jalankan `SELECT * FROM orders WHERE customer_id = 42` sebanyak 5 kali. Catat juga jumlah index di `orders` dari `pg_indexes`.
  - `adapter.statements()` berisi query yang cocok dengan `/customer_id = \$1/`. `adapter.explain(query itu)` menghasilkan `[{ table: 'public.orders' }]`.
  - `analyze(adapter, { connection: 'x', top: 10 })` menghasilkan `suggestions.value.items` yang berisi `{ table: 'public.orders', columns: ['customer_id'], confidence: 'tinggi' }`.
  - `foreignKeys.value` berisi `{ table: 'public.orders', columns: ['customer_id'] }`.
  - Setelah analyze, jumlah index di `orders` sama dengan sebelumnya, dan `pg_stat_statements` masih berisi query tadi (tidak direset).
- [ ] **Step 3: Jalankan `docker compose up -d pg12 pg16 && npm run test:it`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 4: Implementasikan `createPostgresAdapter`.**
  - **Saat konek:** `new pg.Client({ connectionString: url })`, lalu jalankan:
    - `SET application_name = 'db-checkup'`
    - `SET default_transaction_read_only = on`
    - `SET statement_timeout = 5000`
    - `SET lock_timeout = 2000`
    - `SET plan_cache_mode = force_generic_plan`
  - `defaultSchema = 'public'`.
  - **`info()`:**
    - `server_version_num` dan `version()`. Flavor `postgres`.
    - `statsSince`: dari `pg_stat_statements_info.stats_reset` (PG14+, hanya kalau extension ada). Selain itu null.
    - Warning kalau versi < 120000: `Postgres di bawah 12 tidak didukung resmi; hasil bisa tidak lengkap.`
    - Warning hak akses kalau user bukan superuser dan tidak punya `pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')`.
  - **`statements()`:**
    - Kalau `pg_extension` tidak berisi `pg_stat_statements`, atau query gagal dengan pesan `must be loaded via shared_preload_libraries`: lempar `SkipError` dengan instruksi aktivasi. Instruksi mencakup tiga lingkungan:
      - Server sendiri: tambahkan `shared_preload_libraries = 'pg_stat_statements'` di `postgresql.conf`, restart, lalu `CREATE EXTENSION pg_stat_statements;`.
      - AWS RDS: ubah parameter group `shared_preload_libraries`, reboot, lalu `CREATE EXTENSION`.
      - Google Cloud SQL: cukup `CREATE EXTENSION pg_stat_statements;`.
    - Kolom waktu: `total_time`/`mean_time` kalau versi < 130000, `total_exec_time`/`mean_exec_time` kalau lebih baru.
    - Filter: `dbid` = database saat ini.
    - `key = userid || ':' || queryid`.
  - **`explain(stmt)`:**
    - Kalau query tidak diawali `SELECT`/`WITH`: `SkipError('bukan SELECT')`.
    - `PREPARE dbc_explain AS <query>`, lalu `EXPLAIN (FORMAT JSON, VERBOSE) EXECUTE dbc_explain(NULL, …)`. Jumlah `NULL` = nilai `$n` terbesar.
    - Hasil dibaca dengan `pgScans`.
    - `DEALLOCATE dbc_explain` di blok `finally`. Error dari `DEALLOCATE` diabaikan.
  - **`tables()`:** `pg_class` dengan `relkind IN ('r','p')`, di luar schema `pg_catalog`/`information_schema`. `rows = greatest(reltuples, 0)`. Kolom diambil dari `pg_attribute`.
  - **`indexes()`:** `pg_index` digabung `pg_attribute` sesuai urutan `indkey`. Kolom berhenti di ekspresi pertama.
  - **`tableScans(limit)`:** `pg_stat_user_tables` dengan `seq_scan > 0` dan `n_live_tup > MIN_TABLE_ROWS`, diurutkan `seq_tup_read DESC`.
  - **`unindexedForeignKeys()`:** dari `pg_constraint` dengan `contype = 'f'`, yang `conkey`-nya bukan prefix dari `indkey` index mana pun di tabel itu.
  - **`unusedIndexes(limit)`:** `pg_stat_user_indexes` dengan `idx_scan = 0`, `NOT indisunique`, `NOT indisprimary`, diurutkan dari ukuran terbesar.
  - **`longRunning(min)`:** `pg_stat_activity` dengan filter:
    - `datname = current_database()`
    - `state <> 'idle'`
    - `pid <> pg_backend_pid()`
    - `backend_type = 'client backend'`
    - `now() - query_start > make_interval(secs => $1)`
  - **`lockWaits()`:** `pg_stat_activity a` × `unnest(pg_blocking_pids(a.pid))`, digabung lagi ke `pg_stat_activity b` untuk mendapatkan blocker.
  - **`describeError`:** untuk kode `42501`, kembalikan `Hak akses kurang. Jalankan: GRANT pg_read_all_stats TO <user>;`.
- [ ] **Step 5: Jalankan `npm run test:it`. Hasil yang diharapkan: PASS di pg12 dan pg16.**
- [ ] **Step 6: Commit** `feat: postgres adapter`

---

### Task 10: Adapter MySQL/MariaDB + integration test

**Files:**
- Create: `src/adapters/mysql.ts`, `test/fixtures/mysql-init.sql`, `test/integration/mysql.test.ts`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `MysqlOptions` (Task 1), `mysqlScans` (Task 5), `normalizeDigest` (Task 4), `hasPlaceholder` (Task 2), `analyze` (Task 8), `SkipError`.
- Produces: `createMysqlAdapter(opts: MysqlOptions): Promise<DbAdapter>`

- [ ] **Step 1: Tambah service di Docker Compose.**
  - `mysql80` (`mysql:8.0`, port `33080`).
  - `mariadb` (`mariadb:10.11`, port `33110`, `command: --performance-schema=ON`).
  - Keduanya: password root `test`, database `shop`, init `test/fixtures/mysql-init.sql`.
  - `mysql-init.sql` membuat tabel `customers` (20.000 baris) dan `orders` (50.000 baris). Kolom `orders.customer_id` sengaja dibuat **tanpa** foreign key, karena InnoDB otomatis membuat index untuk foreign key, dan skenario full scan jadi hilang. Data diisi lewat `INSERT … SELECT` yang menggandakan baris, bukan CTE rekursif (batas rekursi bawaan MySQL hanya 1000).
- [ ] **Step 2: Tulis integration test yang gagal.**

  File dilewati kalau `DB_CHECKUP_IT !== '1'`. Lewat koneksi `mysql2` biasa, jalankan `query()` (bukan `execute()`, supaya contoh query berisi literal) `SELECT * FROM orders WHERE customer_id = 42` sebanyak 5 kali.
  - **mysql80:** `analyze` menghasilkan saran `{ table: 'shop.orders', columns: ['customer_id'], confidence: 'tinggi' }`, dan `foreignKeys` berupa `{ ok: false }` dengan reason yang cocok `/InnoDB/`.
  - **mariadb:** `info().flavor === 'mariadb'`, `info().warnings` tidak kosong, dan saran untuk `shop.orders` berkeyakinan `'rendah'`.
  - **Keduanya:** jumlah index di `orders` tidak berubah setelah analyze.
- [ ] **Step 3: Jalankan `docker compose up -d mysql80 mariadb && npm run test:it`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 4: Implementasikan `createMysqlAdapter`.**
  - **Saat konek:**
    - `mysql.createConnection(opts)`, lalu baca `VERSION()`. Flavor `mariadb` kalau versi cocok dengan `/mariadb/i`.
    - `SET SESSION TRANSACTION READ ONLY`.
    - Batas waktu: `SET SESSION max_execution_time = 5000` (MySQL) atau `SET SESSION max_statement_time = 5` (MariaDB).
    - `defaultSchema = opts.database`.
  - **`info()`:**
    - `statsSince = now - Uptime`. Nilai `Uptime` dari `SHOW GLOBAL STATUS LIKE 'Uptime'`.
    - Warning untuk MariaDB: `MariaDB: dukungan terbatas. Saran index hanya berdasarkan analisa teks (keyakinan rendah).`
    - Warning untuk versi `5.x`: `MySQL 5.7 sudah end-of-life dan tidak didukung resmi; sebagian analisa dilewati.`
    - Warning kalau `SHOW GRANTS` tidak memuat `PROCESS` atau `ALL PRIVILEGES`: `Tanpa privilege PROCESS, daftar query yang sedang jalan hanya berisi query milik user ini.`
  - **`statements()`:**
    - Kalau `@@performance_schema = 0`: lempar `SkipError` dengan instruksi aktivasi:
      - Server sendiri: `performance_schema = ON` di `my.cnf`, lalu restart.
      - AWS RDS: parameter group `performance_schema = 1`, lalu reboot.
      - Google Cloud SQL: flag `performance_schema` dinyalakan.
      - Catatan: di MariaDB, nilai default-nya mati.
    - Ambil dari `events_statements_summary_by_digest` dengan `SCHEMA_NAME = DATABASE()`.
    - `key = SCHEMA_NAME + ':' + DIGEST`. `query = normalizeDigest(DIGEST_TEXT)`.
    - `sample = QUERY_SAMPLE_TEXT`, hanya kalau kolom itu ada di `information_schema.COLUMNS`. Cek sekali saat konek.
    - Timer dalam picosecond dibagi `1e9` supaya menjadi ms. `rows = SUM_ROWS_SENT`, `rowsExamined = SUM_ROWS_EXAMINED`, `noIndexUsed = SUM_NO_INDEX_USED`.
  - **`explain(stmt)`:** lempar `SkipError` dengan reason berikut, sesuai urutan pengecekan:
    1. `'tidak ada contoh query (QUERY_SAMPLE_TEXT)'` kalau `sample` kosong.
    2. `'contoh query terpotong'` kalau `sample.length >= @@performance_schema_max_sql_text_length`.
    3. `'contoh query memakai placeholder (prepared statement)'` kalau `hasPlaceholder(sample, 'mysql')`.
    4. `'bukan SELECT'` kalau query tidak diawali `SELECT`/`WITH`.

    Kalau lolos semua: jalankan `EXPLAIN FORMAT=JSON <sample>`, parse kolom JSON-nya, lalu baca dengan `mysqlScans`.
  - **`tables()`:** `information_schema.TABLES.TABLE_ROWS` dengan `TABLE_TYPE = 'BASE TABLE'`. Kolom dari `information_schema.COLUMNS`. Nama tabel `${db}.${name}`.
  - **`indexes()`:** `information_schema.STATISTICS`, diurutkan `SEQ_IN_INDEX`. `unique = NON_UNIQUE = 0`, `primary = INDEX_NAME = 'PRIMARY'`.
  - **`tableScans(limit)`:** `sys.schema_tables_with_full_table_scans` dengan `object_schema = DATABASE()`. Kalau schema `sys` tidak ada: `SkipError('schema sys tidak tersedia')`.
  - **`unindexedForeignKeys()`:** selalu `SkipError('Tidak relevan untuk MySQL/MariaDB: InnoDB otomatis membuat index untuk foreign key.')`.
  - **`unusedIndexes(limit)`:** `sys.schema_unused_indexes` digabung `STATISTICS` dengan `NON_UNIQUE = 1`. Kalau `sys` tidak ada, `SkipError` yang sama.
  - **`longRunning(min)`:** `information_schema.PROCESSLIST` dengan `COMMAND <> 'Sleep'`, `ID <> CONNECTION_ID()`, `DB = DATABASE()`, dan `TIME > ?`.
  - **`lockWaits()`:** `sys.innodb_lock_waits`, kolom `waiting_pid`, `waiting_query`, `blocking_pid`, `blocking_query`, dan `wait_age_secs`.
  - **`describeError`:** untuk errno `1142`, `1143`, `1227`, atau `1044`, kembalikan `Hak akses kurang. Jalankan: GRANT SELECT ON performance_schema.* TO <user>; GRANT SELECT ON sys.* TO <user>; GRANT PROCESS ON *.* TO <user>;`.
- [ ] **Step 5: Jalankan `npm run test:it`. Hasil yang diharapkan: PASS di keempat database.**
- [ ] **Step 6: Commit** `feat: mysql and mariadb adapter`

---

### Task 11: CLI + README

**Files:**
- Create: `src/cli.ts`, `README.md`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: semua modul di atas.
- Produces:
  ```ts
  export function main(argv: string[], env: Record<string, string | undefined>,
    io: { stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } },
    deps?: { createAdapter(c: ConnectionConfig): Promise<DbAdapter> }): Promise<number>;   // exit code
  ```
  Baris pertama file adalah `#!/usr/bin/env node`. Kalau file dijalankan langsung, panggil `main(process.argv.slice(2), process.env, process)` lalu set `process.exitCode`.

- [ ] **Step 1: Tulis tes yang gagal.**

  Persiapan di file tes:
  - `fakeAdapter` diimpor dari `test/helpers.ts`.
  - `deps = { createAdapter: async () => fakeAdapter({}) }`.
  - `capture()` mengumpulkan semua `write` ke stdout dan stderr (`isTTY: false`), lalu menyediakan `out()` dan `err()` untuk membaca hasilnya.
  - `dir` adalah direktori temp dari `mkdtemp`.

```ts
test('no url and no DATABASE_URL -> 2', async () => {
  const io = capture(); assert.equal(await main([], {}, io, deps), 2); assert.match(io.err(), /DATABASE_URL/);
});
test('invalid --top -> 2', async () => assert.equal(await main(['postgres://a@h/db', '--top', 'abc'], {}, capture(), deps), 2));
test('invalid --watch -> 2', async () => assert.equal(await main(['postgres://a@h/db', '--watch', '0'], {}, capture(), deps), 2));
test('DATABASE_URL used, password never printed, file written', async () => {
  const io = capture(); const file = join(dir, 'r.md');
  assert.equal(await main(['--output', file], { DATABASE_URL: 'postgres://app:secret@h/shop' }, io, deps), 0);
  const md = await readFile(file, 'utf8');
  assert.match(md, /^# Laporan db-checkup/);
  assert.ok(!io.out().includes('secret') && !md.includes('secret'));
  assert.ok(md.includes('postgres://app:***@h/shop'));
});
test('connection failure -> 1, password redacted in message', async () => {
  const io = capture();
  const failing = { createAdapter: async () => { throw new Error('connect ECONNREFUSED for postgres://app:secret@h/shop'); } };
  assert.equal(await main(['postgres://app:secret@h/shop'], {}, io, failing), 1);
  assert.match(io.err(), /^Gagal konek ke database:/); assert.ok(!io.err().includes('secret'));
});
test('adapter closed even when analysis throws', async () => {
  let closed = 0;
  const d = { createAdapter: async () => fakeAdapter({ info: async () => { throw new Error('boom'); }, close: async () => { closed++; } }) };
  assert.equal(await main(['postgres://a@h/db'], {}, capture(), d), 1);
  assert.equal(closed, 1);
});
```

- [ ] **Step 2: Jalankan `npm test`. Hasil yang diharapkan: FAIL.**
- [ ] **Step 3: Implementasikan `main`.**
  - **Argumen:** `parseArgs` dengan opsi `output` (string), `top` (string), `watch` (string), `no-mask` (boolean), `help` (boolean), dan `version` (boolean). `allowPositionals: true`.
  - **Validasi:** `--top` dan `--watch` harus bilangan bulat positif. Kalau tidak valid, tulis pesan ke stderr dan exit 2. `--help` mencetak usage dalam Bahasa Indonesia lalu exit 0.
  - **Alur:**
    1. `url = positional[0] ?? env.DATABASE_URL`.
    2. `parseConnectionUrl(url)`.
    3. `deps.createAdapter(config)`. Default-nya `createPostgresAdapter(config.url)` atau `createMysqlAdapter(config.mysql)`.
    4. `analyze(adapter, { connection: redactUrl(url), top, watchSeconds, onTick })`, dengan `onTick` yang menulis `\rMenunggu snapshot kedua: <n> detik…` ke stderr hanya kalau `stderr.isTTY`.
    5. `buildReport(result, { mask: !noMask })`.
    6. Tulis `renderTerminal(report, { color: !!stdout.isTTY && !env.NO_COLOR })` ke stdout.
    7. Kalau ada `--output`: `writeFile(output, renderMarkdown(report))`.
    8. `adapter.close()` di blok `finally`.
  - **Pesan error:** semua pesan error yang ditulis ke stderr harus melewati penyamaran password. Ganti setiap kemunculan password (versi asli maupun `decodeURIComponent`) dengan `***`.
    - Gagal di `createAdapter`: prefix `Gagal konek ke database:`, exit 1.
    - Error lain: prefix `Error:`, exit 1.
- [ ] **Step 4: Jalankan `npm test`. Hasil yang diharapkan: PASS.**
- [ ] **Step 5: Tulis README.**

  Gunakan Bahasa Indonesia dan buat pendek:
  - Cara install: `npm install -g .` dari repo ini, atau `npx` setelah dipublish.
  - Contoh perintah untuk Postgres, MySQL, `DATABASE_URL`, `--watch 60`, dan `--output report.md`.
  - Daftar hak akses yang dibutuhkan (dari spec bagian 11).
  - Catatan bahwa tools hanya membaca.
- [ ] **Step 6: Verifikasi end-to-end.**

  Jalankan `npm run build && node dist/cli.js postgres://postgres:test@localhost:54316/postgres --output /tmp/r.md` dengan pg16 sedang jalan. Hasil yang diharapkan: exit 0, dan terminal menampilkan semua section. Lakukan hal yang sama untuk `mysql://root:test@localhost:33080/shop`.
- [ ] **Step 7: Commit** `feat: cli entrypoint and readme`
