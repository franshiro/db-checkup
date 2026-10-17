# Server Configuration Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bagian laporan "Konfigurasi server" (koneksi, memori, kesiapan analisa, versi) dengan angka rekomendasi konkret dan perintah per platform, di menu `dbc`, "Laporan lengkap", dan mode CLI.

**Architecture:** Adapter hanya mengumpulkan fakta mentah (`serverConfig(): Promise<ServerFacts>`). Semua aturan (rumus memori, ambang, EOL, perintah) ada di modul murni `src/config.ts` yang dites tanpa database. `analyze()` mendapat part baru `'config'` dengan input `ServerMemory`; `report.ts` merender hasilnya. Info server (`dedicated`, `ram_mb`) disimpan per koneksi di file `dbb`, RAM lokal dibaca oleh `src/sysmem.ts`.

**Tech Stack:** Node ≥ 20.12, TypeScript strict ESM, `node:os`, `node:fs`, `pg`, `mysql2`, `node:test` + `tsx`. Tanpa dependency baru.

**Spec:** `docs/superpowers/specs/2026-10-17-dbc-server-config-design.md` (melanjutkan `2026-10-17-dbc-interactive-design.md` dan `2026-10-17-db-checkup-design.md`).

## Global Constraints

- Tidak ada dependency baru. Tidak ada perintah yang mengubah server: hanya `SELECT`/`SHOW`, sesi tetap read-only seperti sekarang.
- Teks pengguna bahasa Indonesia; angka `id-ID`; ukuran memori `formatSize`: kelipatan 1024 MB → `NGB`, selain itu `NMB`.
- Jatah RAM J: khusus database = 100% RAM, berbagi = 50% RAM.
- Rumus (J dan hasil dalam MB, dibulatkan ke bawah):
  - Postgres `shared_buffers` = 25% J; `effective_cache_size` = 75% J; `work_mem` = (J − `shared_buffers` disarankan) ÷ (`max_connections` × 3), minimal 4; `maintenance_work_mem` = 5% J, minimal 64, maksimal 2048.
  - MySQL `innodb_buffer_pool_size` = 70% J − `max_connections` × memori per koneksi, minimal 128, dibulatkan ke bawah ke kelipatan 128.
- Perkiraan terburuk: Postgres `shared_buffers` + `max_connections` × `work_mem` + `autovacuum_max_workers` × (`autovacuum_work_mem`, atau `maintenance_work_mem` kalau -1). MySQL `innodb_buffer_pool_size` + `key_buffer_size` (+ `aria_pagecache_buffer_size` MariaDB) + `max_connections` × (`sort_buffer_size` + `join_buffer_size` + `read_buffer_size` + `read_rnd_buffer_size` + `thread_stack` + `binlog_cache_size`).
- Ambang: setting direkomendasikan kalau nilai sekarang < 50% atau > 150% dari nilai disarankan (aturan lengkap di Task 1). Koneksi: peringatan kalau pemakaian sekarang atau puncak ≥ 80% dari batas efektif. Idle lama: `idle` > 10 menit, `idle in transaction` > 1 menit (Postgres), `Sleep` > 600 detik (MySQL).
- EOL (data per 2026-10-17; tandai "segera" kalau ≤ 6 bulan lagi): Postgres 12 2024-11, 13 2025-11, 14 2026-11, 15 2027-11, 16 2028-11, 17 2029-11, 18 2030-11; MySQL 5.7 2023-10, 8.0 2026-04, 8.4 2032-04; MariaDB 10.6 2026-07, 10.11 2028-02, 11.4 2029-05.
- Prioritas CLI: RAM = `--ram` > `ram_mb` tersimpan > dibaca otomatis (host lokal) > tidak diketahui; jenis = `--shared`/`--dedicated` > `dedicated` tersimpan > khusus database. CLI tidak pernah menulis file koneksi.
- File koneksi: aturan Task 2 dari plan sebelumnya tetap (tulis atomik, izin 600, entri lain utuh, file rusak tidak ditulis).
- Test: `node:test`, import `../src/x.js`. Commit message tanpa baris atribusi apa pun.

## Review Focus

1. Rekomendasi yang membuat server lebih buruk: setelah rekomendasi, perkiraan terburuk dengan nilai disarankan harus ≤ J, atau laporan menyatakan "RAM terlalu kecil". Test di Task 1.
2. Satuan salah: `pg_settings` memberi `setting` dalam unit (8kB, kB, MB), MySQL dalam byte; perintah MySQL `SET PERSIST/GLOBAL` butuh angka byte, sedangkan `my.cnf` boleh `5G`. Test di Task 1 (perintah) dan Task 3 (normalisasi byte terhadap server nyata).
3. Info server yang hilang atau basi: entri ditimpa dengan host/port berbeda tidak boleh membawa `ram_mb` lama; field tidak valid tidak boleh membuat entri hilang. Test di Task 4.
4. Hak akses kurang: MySQL tanpa `PROCESS` atau Postgres tanpa `pg_read_all_stats` tidak boleh membuat seluruh bagian gagal; rincian ditandai sebagian. Test di Task 3 (fakta `partial`) dan Task 1 (render penanda).
5. RAM tidak diketahui (host remote tanpa `--ram`): bagian koneksi, kesiapan, dan versi tetap tampil; rekomendasi memori dilewati dengan pesan yang menyebut `--ram`. Test di Task 1 dan Task 4.

---

### Task 1: Aturan konfigurasi (modul murni)

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `type Flavor = 'postgres' | 'mysql' | 'mariadb'`
  - `interface Setting { value: string; bytes?: number; restart: boolean }` — `bytes` hanya untuk setting ukuran memori, sudah dinormalisasi ke byte.
  - `interface ConnGroup { database?: string; user: string; app: string; state: string; count: number; idleLong: number }`
  - `interface ServerFacts { flavor: Flavor; version: string; settings: Record<string, Setting>; connections: { max: number; reserved: number; used: number; peak?: number; rejected?: number; partial: boolean; groups: ConnGroup[] }; pgStatStatements?: { preloaded: boolean; created: boolean }; digestConsumer?: boolean }` — `version` angka saja, mis. `16.4`, `8.0.39`, `10.11.8`.
  - `interface ServerMemory { totalMb?: number; availableMb?: number; source: 'lokal' | 'manual' | 'flag' | null; dedicated: boolean }`
  - `interface Rec { setting: string; current: string; suggested: string; reason: string; restart: boolean }`
  - `interface ConfigResult { connections: ServerFacts['connections'] & { effective: number; usagePct: number; warn: boolean; advice: string[] }; memory: { quotaMb?: number; totalMb?: number; availableMb?: number; source: ServerMemory['source']; dedicated: boolean; worstMb: number; worstAfterMb?: number; overflow: boolean; tooSmall?: boolean; skipped?: string }; recs: Rec[]; readiness: { item: string; ok: boolean; fix?: string; restart?: boolean }[]; version: { major: string; eol?: string; status: 'eol' | 'segera' | 'ok' | 'unknown' }; commands: { platform: 'Server sendiri' | 'AWS RDS' | 'Google Cloud SQL'; lines: string[] }[] }`
  - `analyzeConfig(f: ServerFacts, m: ServerMemory, today: Date): ConfigResult`
  - `parseSize(s: string): number | null` — MB; menerima `8G`, `8GB`, `512M`, `512MB`, `1.5G`, huruf kecil; selain itu `null`.
  - `formatSize(mb: number): string`

Urutan rekomendasi memori (dari spec):
1. Hitung set R dengan `max_connections` sekarang.
2. Kalau perkiraan terburuk dengan R > J: turunkan `work_mem` (Postgres) / buffer pool (MySQL) sampai muat, tidak di bawah batas bawah.
3. Kalau tetap tidak muat: `max_connections` baru = nilai terbesar yang membuat perkiraan terburuk (dengan batas bawah) ≤ J, dibulatkan ke bawah ke kelipatan 10, plus saran pooler; kalau < 20 → `tooSmall`, tanpa rekomendasi memori.
4. Tampilkan setting kalau nilai sekarang < 50% atau > 150% dari R, atau setting itu diubah di langkah 2–3 dan perkiraan terburuk dengan nilai sekarang > J.

- [ ] **Step 1: Write the failing tests:**
  - `parseSize('8G') === 8192`, `parseSize('512m') === 512`, `parseSize('1.5GB') === 1536`, `parseSize('abc') === null`; `formatSize(4096) === '4GB'`, `formatSize(40) === '40MB'`.
  - Postgres khusus 16GB (`totalMb: 16384`, `dedicated: true`), `max_connections` 100, `autovacuum_max_workers` 3, `autovacuum_work_mem` -1, nilai sekarang default (128MB, 4GB, 4MB, 64MB) → suggested `shared_buffers` `4GB`, `effective_cache_size` `12GB`, `work_mem` `40MB`, `maintenance_work_mem` `819MB`; semua empat muncul di `recs` (di luar 50–150%); `memory.worstAfterMb === 4096 + 100*40 + 3*819`.
  - Sama tapi `dedicated: false` → `quotaMb === 8192`, `shared_buffers` `2GB`, `work_mem` `20MB`, `maintenance_work_mem` `409MB`.
  - Nilai sekarang di dalam 50–150% (mis. `shared_buffers` 3GB vs 4GB disarankan) dan tidak overflow → `shared_buffers` tidak ada di `recs`.
  - Postgres J=1024 (`totalMb: 1024`, khusus), `max_connections` 500 → `work_mem` `4MB`, `maintenance_work_mem` `64MB`, rekomendasi `max_connections` `140`, `advice` memuat `PgBouncer`, `worstAfterMb ≤ 1024`.
  - Postgres J=256, `max_connections` 100 → `tooSmall === true`, tidak ada rec memori.
  - MySQL khusus 8GB, `max_connections` 100, enam buffer per koneksi masing-masing 1MB, `key_buffer_size` 8MB → `innodb_buffer_pool_size` disarankan `5GB` (5734 − 600 → 5120).
  - MariaDB: `aria_pagecache_buffer_size` ikut dihitung di `worstMb`.
  - `totalMb` undefined → `memory.skipped` memuat `--ram`, `recs` tanpa setting memori, `connections`/`readiness`/`version` tetap terisi.
  - Koneksi: max 100, reserved 3, used 80 → `effective === 97`, `warn === true`; MySQL `peak` 95 dari 100 → `warn`; Postgres grup dengan `state: 'idle in transaction'` dan `idleLong > 0` → rec `idle_in_transaction_session_timeout` `60s`; MySQL grup `Sleep` dengan `idleLong > 0` → rec `wait_timeout` `600`.
  - Kesiapan Postgres: `pgStatStatements.preloaded === false` → item tidak ok dengan `fix` memuat `shared_preload_libraries` dan `restart: true`; `track_io_timing` `off` → item tidak ok. MySQL `performance_schema` `OFF` → fix memuat `[mysqld]` dan `performance_schema = ON`; `digestConsumer === false` → fix memuat `setup_consumers`.
  - Versi dengan `today = new Date(2026, 9, 17)`: postgres `12.20` → `eol`; `14.13` → `segera`; `16.4` → `ok`; mysql `8.0.39` → `eol`; mariadb `10.11.8` → `ok`; postgres `19.0` → `unknown`.
  - Perintah: Postgres rec `shared_buffers` → baris `ALTER SYSTEM SET shared_buffers = '4GB';` dan `SELECT pg_reload_conf();`, plus catatan restart karena `restart: true`. MySQL 8.0 rec buffer pool → `SET PERSIST innodb_buffer_pool_size = 5368709120;` (byte) dan `my.cnf` baris `innodb_buffer_pool_size = 5G`; MariaDB → `SET GLOBAL ...` + `my.cnf`. Ada tiga platform, RDS/Cloud SQL berisi `nama = nilai` tanpa SQL.
- [ ] **Step 2: Run** `node --import tsx --test test/config.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/config.ts` mengikuti spec bagian "Isi bagian" dan "Perintah per platform". Setting tidak dinamis MySQL (`performance_schema`) sebagai daftar kecil di kode. Teks alasan singkat, bahasa Indonesia.
- [ ] **Step 4: Run** test — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: server configuration rules and recommendations"`

### Task 2: RAM lokal dan ukuran

**Files:**
- Create: `src/sysmem.ts`
- Test: `test/sysmem.test.ts`

**Interfaces:**
- Produces:
  - `isLocalHost(host: string): boolean` — `localhost`, `127.0.0.0/8`, `::1`, `[::1]`, string kosong, atau diawali `/` (Unix socket).
  - `localMemory(read?: (p: string) => Promise<string>): Promise<{ totalMb: number; availableMb?: number }>` — `totalMb` dari `os.totalmem()`; `availableMb` hanya di Linux dari `MemAvailable` di `/proc/meminfo` (kB → MB); `read` disuntikkan untuk test.
  - `hostOf(c: ConnectionConfig): string` — Postgres dari URL (`host` query param menang, mis. socket), MySQL dari `mysql.host`.

- [ ] **Step 1: Write the failing tests:** `isLocalHost` true untuk `localhost`, `127.0.0.1`, `127.1.2.3`, `::1`, `/var/run/postgresql`, `''`; false untuk `db.toko.id`, `10.0.0.5`. `localMemory` dengan `read` yang mengembalikan `MemAvailable:  2048000 kB` → `availableMb === 2000` saat `process.platform === 'linux'` (lewati assert itu di platform lain), `totalMb > 0`. `hostOf` untuk `postgres://u@h:5/db`, `postgres://u@/db?host=/tmp`, dan config MySQL.
- [ ] **Step 2: Run** `node --import tsx --test test/sysmem.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: detect local host and read local RAM"`

### Task 3: Adapter `serverConfig()`

**Files:**
- Modify: `src/types.ts` (`DbAdapter.serverConfig(): Promise<ServerFacts>`), `src/adapters/postgres.ts`, `src/adapters/mysql.ts`, `test/helpers.ts` (`fakeAdapter` default `serverConfig` yang melempar `SkipError`)
- Test: `test/integration/postgres.test.ts`, `test/integration/mysql.test.ts`

**Interfaces:**
- Consumes: `ServerFacts`, `Setting`, `ConnGroup` dari Task 1.
- Produces: `serverConfig()` di kedua adapter. Daftar setting tepat:
  - Postgres (`pg_settings`; `bytes` = `setting` × unit untuk unit `8kB`/`kB`/`MB`; `restart` = `context = 'postmaster'`): `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `autovacuum_work_mem`, `autovacuum_max_workers`, `max_connections`, `superuser_reserved_connections`, `reserved_connections` (PG16+, tidak ada di bawahnya), `shared_preload_libraries`, `track_io_timing`, `track_activity_query_size`, `log_min_duration_statement`, `idle_in_transaction_session_timeout`. `version` dari `SHOW server_version` (angka saja). Koneksi dari `pg_stat_activity` seluruh server dengan `backend_type = 'client backend'`, dikelompokkan per `datname`, `usename`, `application_name`, `state`; `idleLong` = jumlah `idle` dengan `state_change` > 10 menit atau `idle in transaction` > 1 menit; `partial` = bukan superuser dan tidak punya `pg_read_all_stats`. `pgStatStatements` = `{ preloaded: shared_preload_libraries memuat pg_stat_statements, created: extension ada }`.
  - MySQL/MariaDB (`SHOW GLOBAL VARIABLES`, nilai ukuran sudah byte; `restart` dari daftar tidak dinamis di Task 1): `innodb_buffer_pool_size`, `key_buffer_size`, `aria_pagecache_buffer_size` (MariaDB), `sort_buffer_size`, `join_buffer_size`, `read_buffer_size`, `read_rnd_buffer_size`, `thread_stack`, `binlog_cache_size`, `max_connections`, `wait_timeout`, `interactive_timeout`, `performance_schema`, `slow_query_log`, `long_query_time`, `innodb_buffer_pool_chunk_size`, `innodb_buffer_pool_instances`. `used` = `Threads_connected`; `peak` = `Max_used_connections`; `rejected` = `Connection_errors_max_connections`; grup dari `information_schema.PROCESSLIST` per `USER`, host tanpa port, `COMMAND`; `idleLong` = `Sleep` dengan `TIME` > 600; `partial` = tanpa privilege `PROCESS` (cek `SHOW GRANTS` seperti `info()`); `digestConsumer` dari `performance_schema.setup_consumers` `statements_digest` (false kalau `performance_schema` OFF).
  - Semua query diawali tag `/* db-checkup */` (Postgres) seperti query lain di adapter.

- [ ] **Step 1: Write the failing integration tests** (`DB_CHECKUP_IT=1`, container yang ada): pg12 dan pg16 → `settings.shared_buffers.bytes === 134217728` (default 128MB), `settings.shared_buffers.restart === true`, `settings.work_mem.restart === false`, `connections.used >= 1`, ada grup dengan `user === 'postgres'`, `pgStatStatements.preloaded === true`; pg16 punya `reserved_connections`, pg12 tidak. mysql80 → `flavor === 'mysql'`, `settings.innodb_buffer_pool_size.bytes > 0`, `connections.peak >= 1`, `digestConsumer === true`, `partial === false` (root). mariadb → `flavor === 'mariadb'`, `settings.aria_pagecache_buffer_size` ada.
- [ ] **Step 2: Run** `npm run test:it` — Expected: test baru FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:it` dan `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: collect server configuration facts from postgres and mysql"`

### Task 4: Part `config`, laporan, CLI, dan field koneksi

**Files:**
- Modify: `src/types.ts` (`AnalysisPart` + `'config'`, `AnalysisResult.config?: Outcome<ConfigResult>`), `src/analyze.ts`, `src/report.ts`, `src/cli.ts`, `src/store.ts`
- Test: `test/analyze.test.ts`, `test/report.test.ts`, `test/cli.test.ts` (tambah saja), `test/store.test.ts`

**Interfaces:**
- Consumes: Task 1–3.
- Produces:
  - `analyze(adapter, opts & { server?: ServerMemory; today?: Date })` — part `'config'` memanggil `adapter.serverConfig()` lalu `analyzeConfig(facts, opts.server ?? { source: null, dedicated: true }, opts.today ?? new Date())`; tanpa `parts` ikut dijalankan (Laporan lengkap).
  - `buildReport`: section `Konfigurasi server` setelah section yang sudah ada, berisi: tabel koneksi (batas efektif, terpakai, %, puncak/ditolak kalau ada) + tabel grup (+ penanda "sebagian" kalau `partial`); baris memori (total RAM + sumber, jatah, RAM tersedia kalau ada, perkiraan terburuk, peringatan "Dalam kondisi terburuk, setting memori bisa melebihi RAM" kalau `overflow`, pesan `skipped`/`tooSmall`); tabel rekomendasi `Setting | Sekarang | Disarankan | Alasan | Restart`; perkiraan terburuk setelah rekomendasi; tabel kesiapan; baris versi; blok kode per platform.
  - `SavedConnection` + `dedicated?: boolean; ram_mb?: number`. `loadConnections`: field tidak valid tidak ikut di objek hasil (entri tetap valid), tetap utuh di file. `saveConnection` saat menimpa: pertahankan `bulk`; pertahankan `dedicated` dan `ram_mb` kecuali `host` atau `port` berubah.
  - CLI opsi `--ram <ukuran>`, `--shared`, `--dedicated` untuk mode URL dan `dbc <nama>`; `--shared` dan `--dedicated` bersamaan → exit 2; `--ram` tidak valid → exit 2. `ServerMemory` dibangun dengan prioritas di Global Constraints (`isLocalHost(hostOf(config))` → `localMemory()`). USAGE menyebut ketiganya.

- [ ] **Step 1: Write the failing tests:**
  - `analyze` dengan `parts: ['config']` dan fake `serverConfig` → hanya `info` dan `serverConfig` terpanggil; `result.config.ok`. Tanpa `parts` → `config` ada. `serverConfig` melempar `SkipError('x')` → `config` `{ ok: false }` dan bagian lain tetap.
  - `buildReport` dengan `config` → judul section terakhir `Konfigurasi server`; Markdown memuat `| shared_buffers |` dan blok ```` ```sql ```` dengan `ALTER SYSTEM`; `partial` → teks memuat `sebagian`.
  - Store: entri dengan `dedicated: 'ya'` dan `ram_mb: -1` tetap terdaftar tanpa kedua field, file tidak berubah setelah menyimpan entri lain; timpa dengan host sama → `dedicated`/`ram_mb` bertahan; timpa dengan host berbeda → keduanya hilang, `bulk` tetap.
  - CLI: `main(['postgres://a@db.remote/x', '--ram', '8G', '--shared'])` → laporan memuat `4GB` sebagai jatah (atau baris jatah 50%); `--ram abc` → exit 2; `--shared --dedicated` → exit 2; tanpa `--ram` dan host remote → laporan memuat `--ram` (pesan dilewati); `dbc <nama>` dengan `ram_mb: 4096, dedicated: false` tersimpan → jatah `2GB`.
  - Semua test lama tetap lulus tanpa diubah.
- [ ] **Step 2: Run** `npm test` — Expected: test baru FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` dan `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: server configuration section in reports and CLI"`

### Task 5: Menu

**Files:**
- Modify: `src/menu.ts`
- Test: `test/menu.test.ts`

**Interfaces:**
- Consumes: Task 2 (`isLocalHost`, `localMemory`, `hostOf`), Task 4 (`server` opt, store fields), `parseSize`.
- Produces: pilihan layar 2 "Konfigurasi server" (`parts: ['config']`) setelah "Kesehatan index", dan "Ubah info server" sebelum "← Kembali". `MenuDeps` + `memory?: () => Promise<{ totalMb: number; availableMb?: number }>` (default `localMemory`, disuntikkan di test).

Perilaku (spec "Menentukan jatah RAM"): saat "Konfigurasi server" atau "Laporan lengkap" dipilih dan koneksi belum punya `dedicated` (atau RAM belum diketahui untuk host non-lokal), tanya `select` "Server ini khusus database?" (Ya / Berbagi dengan aplikasi) lalu `ask` "Besar RAM server (mis. 8G)" dengan default angka lokal kalau host lokal ("… terbaca dari mesin ini"). Koneksi tersimpan: simpan `dedicated` dan `ram_mb` lewat `saveConnection` (entri lengkap dari store, bukan objek parsial). Baris tidak tersimpan: tanya setiap kali, tidak disimpan. Esc pada pertanyaan → batal, kembali ke layar 2. "Ubah info server" mengajukan pertanyaan yang sama tanpa syarat.

- [ ] **Step 1: Write the failing tests:**
  - Koneksi tersimpan `prod` tanpa info → "Konfigurasi server" → jawab Berbagi + `8G` → laporan memuat `Konfigurasi server` dan jatah `4GB`; store `prod` sekarang `dedicated: false, ram_mb: 8192`, field lain sama.
  - Jalankan lagi pada sesi berikutnya → tidak ada pertanyaan (output tidak memuat "khusus database?").
  - Host lokal (`localhost`), `memory` palsu `{ totalMb: 16384 }` → prompt RAM memuat default `16G`.
  - Baris `dari .env` → pertanyaan muncul, store tidak berubah.
  - "Ubah info server" → pertanyaan muncul walau info sudah ada; jawaban baru tersimpan.
  - Esc pada pertanyaan jenis server → kembali ke layar 2, analisa tidak berjalan (`serverConfig` tidak terpanggil).
- [ ] **Step 2: Run** `node --import tsx --test test/menu.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: server configuration in the dbc menu"`

### Task 6: Dokumentasi dan uji nyata

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** README (bahasa Indonesia): bagian "Konfigurasi server" — apa yang dicek, cara jatah RAM dihitung (khusus 100%, berbagi 50%), pertanyaan di menu dan field `dedicated`/`ram_mb`, opsi `--ram`/`--shared`/`--dedicated` dan urutan prioritasnya, bahwa angka adalah titik awal dari pedoman umum, perintah tidak pernah dijalankan otomatis, `ALTER SYSTEM` butuh superuser.
- [ ] **Step 2: Verify** `npm test`, `npm run build`, `npm run test:it` lulus. Lalu dengan container (pg16 localhost:54316, mysql80 localhost:33080), `DBB_CONFIG` di scratchpad:
  - `node dist/cli.js postgres://postgres:test@localhost:54316/postgres --ram 2G --shared` → exit 0, bagian `Konfigurasi server` dengan jatah `1GB`, ada rekomendasi `shared_buffers` dan perintah `ALTER SYSTEM`; sesi tetap read-only (nilai `SHOW shared_buffers` sebelum dan sesudah sama).
  - Sama untuk mysql80 dengan `--ram 4G` → rekomendasi `innodb_buffer_pool_size` dan `SET PERSIST` dengan angka byte.
  - Menu lewat `script`/`expect`: pilih koneksi → Konfigurasi server → jawab pertanyaan → laporan tampil → simpan .md → q q; file store memuat `dedicated`/`ram_mb`.
  - Dilarang menjalankan `install.sh`, `npm install -g`, atau `npm uninstall -g`; dilarang menyentuh `~/.dbb`.
- [ ] **Step 3: Commit** `git commit -m "docs: document server configuration analysis"`
