# dbc Interactive Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Perintah `dbc` dengan menu panah: pilih koneksi tersimpan (file yang sama dengan `dbb`) atau dari `.env`, pilih jenis analisa, simpan laporan `.md`, kembali ke menu. Mode CLI lama tetap identik.

**Architecture:** Tiga modul murni baru: `dotenv.ts` (parser `.env` + kandidat koneksi, port dari `dbb.py`), `store.ts` (baca/tulis `~/.dbb/databases.json` tanpa merusak field `dbb`), dan perubahan kecil `analyze()` (opsi `parts` + `signal`). Di atasnya `tui.ts` (select/ask/confirm dengan `node:readline` keypress, input disuntikkan untuk test), `add.ts` (alur tambah koneksi manual/.env), `menu.ts` (layar 1, layar 2, setelah laporan). `cli.ts` hanya dispatch.

**Tech Stack:** Node ≥ 20.12, TypeScript strict ESM, `node:readline`, `node:test` + `tsx`. Tanpa dependency baru.

**Spec:** `docs/superpowers/specs/2026-10-17-dbc-interactive-design.md` (melanjutkan `docs/superpowers/specs/2026-10-17-db-checkup-design.md`). Acuan perilaku `.env`: `dbb.py` di repo `franshiro/db-backup` (`read_env`, `env_candidates`, `add_from_env`).

## Global Constraints

- Tidak ada dependency runtime atau dev baru.
- Semua teks yang terlihat pengguna dalam bahasa Indonesia. Warna mati kalau bukan TTY atau `NO_COLOR` diset.
- Mode CLI lama (`dbc|db-checkup <url> [--top --watch --output --no-mask]`, dan tanpa argumen di non-TTY memakai `DATABASE_URL`) harus identik; semua test di `test/cli.test.ts` tetap lulus tanpa diubah.
- Menu hanya terbuka kalau argv kosong **dan** stdin serta stdout TTY.
- File koneksi: `$DBB_CONFIG`, else `$DBB_HOME/databases.json`, else `~/.dbb/databases.json`. Ditulis via file sementara di folder yang sama + rename, izin `0o600`, JSON indent 2 + newline di akhir. Field dan entri yang tidak disentuh dipertahankan apa adanya, urutan entri tetap. File rusak tidak pernah ditulis.
- Password tidak pernah tampil di layar, laporan, atau error. Masking literal selalu aktif di menu.
- Default port: postgres 5432, mysql 3306. Default user: postgres `postgres`, mysql `root`.
- Default jeda Pantau perubahan: 60 detik. Nama file laporan default: `./<nama-aman>-<YYYYMMDD-HHmm>.md` (waktu lokal), karakter selain `[A-Za-z0-9._-]` di nama koneksi diganti `-`.
- Terminal selalu dikembalikan (raw mode off, kursor tampil) di `finally`, termasuk saat error dan Ctrl-C.
- Test: `node:test`, import `../src/x.js`. Commit message tanpa baris atribusi apa pun.

## Review Focus

1. Exception atau Ctrl-C di tengah menu: terminal harus kembali normal (raw mode off, kursor tampil) dan koneksi tertutup. Test di Task 4 dan Task 6.
2. Menyimpan koneksi ke file `dbb` yang berisi entri lain dengan field `bulk`/`version`/field asing: semua harus utuh, byte selain entri yang diubah sama. Test di Task 2.
3. Password `.env` dengan `@`, `#`, `%`, `/`, spasi: connection string yang dibangun harus konek dengan password yang sama persis dan tetap tersamarkan. Test di Task 2 (`connectionUrl` round-trip lewat `parseConnectionUrl`).
4. Terminal sempit (40 kolom) dan nama koneksi panjang: menu tidak crash, label dipotong, daftar lebih tinggi dari layar bisa di-scroll. Test di Task 4.
5. `dbc` dibuka di folder tanpa `.env`, atau `.env` tidak bisa dibaca, atau file koneksi belum ada: menu tetap jalan dengan daftar kosong dan "+ Tambah koneksi" terpilih. Test di Task 6.

---

### Task 1: Parser `.env` dan kandidat koneksi

**Files:**
- Create: `src/dotenv.ts`
- Test: `test/dotenv.test.ts`

**Interfaces:**
- Produces:
  - `parseEnv(text: string): Record<string, string>`
  - `interface EnvCandidate { src: string; prefix: string; type: 'postgres' | 'mysql' | null; host: string; port: number | null; user: string; password: string; database: string; ssl?: string }`
  - `envCandidates(env: Record<string, string>): EnvCandidate[]`
  - `defaultName(envPath: string, prefix: string): string`

- [ ] **Step 1: Write the failing tests** — port `test_env.py` milik `dbb` apa adanya sebagai fixture `ENV` (Laravel style, `#DB_HOST=old-server`, `DB_PASSWORD="p@ss#word"   # quoted, inline comment`, `# DATABASE_URL=...`, `REPORT_DATABASE_URL=mysql://rep:s%40cret@db.local:3307/reports?ssl=true`, `export PGHOST=pg.local`, `PGUSER=${DB_USERNAME}`, `PGDATABASE=analytics`, REDIS_*, MAIL_*). Assertions:
  - `parseEnv`: `DATABASE_URL` tidak ada; `DB_HOST === '10.0.0.5'`; `DB_PASSWORD === 'p@ss#word'`; `PGUSER === 'mes'`.
  - `envCandidates`: `src` set persis `{'DB_*', 'REPORT_DATABASE_URL', 'PG_*'}`; `DB_*` → `postgres, 10.0.0.5, 5433, mes, p@ss#word, mes_dev`; `REPORT_DATABASE_URL` → `mysql, db.local, 3307, rep, s@cret, reports, ssl 'true'`; `PG_*` → `postgres, pg.local, 5432, mes, analytics`; grup `*_` (PREFIX_*) diurutkan sebelum URL.
  - URL `postgres://u:p@h/db?sslmode=require` → `ssl === 'require'`; skema `postgresql+psycopg://` dan `mariadb://` dikenali.
  - Grup tanpa petunjuk jenis dan port bukan 5432/3306 → `type === null`, `port === null`.
  - Duplikat (host, port, user, database sama) dari URL dan grup → satu kandidat.
  - `defaultName('/x/shop/.env.production', 'REPORT_DATABASE') === 'shop-production-report'`; `defaultName('/x/shop/.env', '') === 'shop'`; `defaultName('/x/shop/.env', 'DB') === 'shop'`.
- [ ] **Step 2: Run** `node --import tsx --test test/dotenv.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** mengikuti `read_env`, `db_type`, `env_candidates`, dan rumus nama di `add_from_env` dari `dbb.py`: suffix map `ENV_SUFFIX` dicocokkan terpanjang dulu, awalan `PG` khusus, `ENV_SKIP` = REDIS, MONGO, CACHE, QUEUE, MAIL, SMTP, ELASTIC, RABBIT, AMQP, KAFKA, AWS, S3. Tambahan dari `dbb`: simpan `ssl` dari query URL (`sslmode` untuk postgres, `ssl` untuk mysql).
- [ ] **Step 4: Run** test — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/dotenv.ts test/dotenv.test.ts && git commit -m "feat: parse .env files into connection candidates"`

### Task 2: File koneksi bersama `dbb`

**Files:**
- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `parseConnectionUrl` (`src/connection.ts`).
- Produces:
  - `interface SavedConnection { name: string; type: 'postgres' | 'mysql'; host: string; port: number; user: string; password: string; database: string; version?: string; ssl?: string }`
  - `class StoreError extends Error {}` — pesan tidak pernah memuat isi file.
  - `storePath(env: Record<string, string | undefined>, home?: string): string`
  - `loadConnections(path: string): Promise<{ connections: SavedConnection[]; warnings: string[] }>` — file belum ada → `[]`; JSON rusak/bukan array → throw `StoreError`; entri tanpa name/host/user/database atau type selain postgres/mysql → tidak dikembalikan; port/password kosong → default (tanpa ditulis balik); nama ganda → entri pertama; izin lebih longgar dari 600 → satu warning.
  - `saveConnection(path: string, c: SavedConnection): Promise<void>` — baca ulang file mentah, ganti entri pertama bernama sama dengan `{...lama, ...baru}` di posisinya (field asing seperti `bulk` tetap), atau tambahkan di akhir; file rusak → `StoreError`, tidak menulis.
  - `removeConnection(path: string, name: string): Promise<boolean>`
  - `connectionUrl(c: SavedConnection): string` — percent-encode user, password, database; `ssl` jadi `?sslmode=` (postgres) atau `?ssl=` (mysql).

- [ ] **Step 1: Write the failing tests** (temp dir):
  - `storePath({DBB_CONFIG:'/a/b.json'})==='/a/b.json'`; `storePath({DBB_HOME:'/h'})==='/h/databases.json'`; `storePath({}, '/home/u')==='/home/u/.dbb/databases.json'`.
  - Simpan ke file berisi `[{"name":"a",...,"bulk":true,"x":{"y":1}},{"name":"b",...}]`: replace `a` → `bulk` dan `x` tetap, urutan `a,b` tetap, `b` deep-equal sebelum; file berakhir `\n`, indent 2; `(await stat(p)).mode & 0o777 === 0o600`; tidak ada file sisa `.tmp` di folder.
  - File belum ada (folder juga belum ada) → `saveConnection` membuat keduanya.
  - File `{not json` → `loadConnections` dan `saveConnection` reject `StoreError`, isi file tidak berubah, pesan error tidak memuat `not json`.
  - Entri `{"name":"x","type":"oracle",...}` dan entri tanpa `host` tidak muncul di `connections`, tapi masih ada di file setelah `saveConnection` entri lain.
  - Izin 0o644 → `warnings.length === 1`.
  - `connectionUrl` round-trip: password `p@ss#w/rd %x` dan user `a@b` → `parseConnectionUrl(connectionUrl(c))` memberi user/password/database yang sama (mysql: `mysql.user`/`mysql.password`; postgres: decode dari `new URL(url)`); `ssl:'require'` postgres → URL memuat `sslmode=require`; mysql `ssl:'skip-verify'` → `parseConnectionUrl` sukses.
- [ ] **Step 2: Run** `node --import tsx --test test/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** di `src/store.ts`. Tulis atomik: `writeFile(tmp, data, { mode: 0o600 })`, `rename(tmp, path)`, lalu `chmod(path, 0o600)`.
- [ ] **Step 4: Run** test — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: read and write the connection list shared with dbb"`

### Task 3: `analyze()` per bagian dan bisa dibatalkan

**Files:**
- Modify: `src/types.ts` (`AnalysisResult`), `src/analyze.ts`, `src/report.ts`
- Test: `test/analyze.test.ts`, `test/report.test.ts`

**Interfaces:**
- Produces:
  - `type AnalysisPart = 'statements' | 'suggestions' | 'tableScans' | 'foreignKeys' | 'unusedIndexes' | 'running' | 'locks'` (di `src/types.ts`)
  - `analyze(adapter, opts & { parts?: AnalysisPart[]; signal?: AbortSignal })` — default semua bagian.
  - `AnalysisResult`: `cumulative`, `suggestions`, `tableScans`, `foreignKeys`, `unusedIndexes`, `running`, `locks` menjadi opsional; bagian yang tidak diminta `undefined`.
  - `buildReport` melewati bagian `undefined` (Ringkasan selalu ada).

- [ ] **Step 1: Write the failing tests:**
  - `parts: ['running','locks']` dengan `fakeAdapter` yang setiap method lain melempar → tidak ada method lain terpanggil kecuali `info`/`longRunning`/`lockWaits`; hasil hanya punya `running` dan `locks`.
  - `parts: ['suggestions']` → `statements()` dipanggil (sumber saran), `result.cumulative === undefined`, `result.suggestions` ada.
  - Tanpa `parts` → hasil sama dengan sebelumnya (test lama tetap lulus).
  - `signal` di-abort saat hitung mundur `watchSeconds: 3` (abort di `onTick` kedua) → `analyze` reject dengan `err.name === 'AbortError'`, `sleep` tidak dipanggil lagi setelah abort.
  - `signal` sudah di-abort sebelum langkah `tableScans` → `tableScans` tidak dipanggil.
  - `buildReport` hasil dengan hanya `running`/`locks` → judul section persis `['Ringkasan', 'Query yang sedang jalan lama (> 5 detik)', 'Query yang saling mengunci']`.
- [ ] **Step 2: Run** `npm test` — Expected: test baru FAIL.
- [ ] **Step 3: Implement.** `suggestions` mengambil snapshot statement sendiri kalau `statements` tidak diminta. `signal.throwIfAborted()` sebelum setiap langkah dan setiap detik hitung mundur; `AbortError` tidak ditangkap oleh `run()` (lempar ulang).
- [ ] **Step 4: Run** `npm test` — Expected: semua PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: run selected analysis parts and support cancellation"`

### Task 4: Primitif TUI

**Files:**
- Create: `src/tui.ts`
- Test: `test/tui.test.ts`

**Interfaces:**
- Produces:
  - `interface Term { input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(on: boolean): unknown }; output: { write(s: string): unknown; columns?: number; rows?: number }; color: boolean }`
  - `interface Item { label: string; desc?: string }`
  - `select(t: Term, title: string, items: Item[], opts?: { initial?: number; keys?: string[] }): Promise<{ index: number; key: string } | null>` — ↑↓/j/k gerak (melingkar), Enter → `key: 'enter'`, huruf di `opts.keys` → `key: <huruf>`, q/Esc/Ctrl-C → `null`. Baris terpilih diawali `➤`. Baris bantuan bawah memuat tombol yang berlaku.
  - `ask(t: Term, label: string, opts?: { default?: string; hidden?: boolean }): Promise<string | null>` — Enter kosong → default; `hidden` tidak menggema karakter; Esc/Ctrl-C → `null`.
  - `confirm(t: Term, question: string, def?: boolean): Promise<boolean>`
  - `logo(t: Term, version: string): string` — header gaya A (logo ASCII besar + `analisa database · hanya membaca · v<versi>`).

- [ ] **Step 1: Write the failing tests** dengan input `PassThrough` + `setRawMode` spy, output string:
  - `select` 3 item, kirim `\x1b[B`, `\x1b[B`, `\r` → `{index: 2, key: 'enter'}`; `\x1b[A` dari index 0 → index 2 (melingkar).
  - `select` dengan `keys: ['d']`, kirim `d` → `{index: 0, key: 'd'}`; kirim `q` → `null`; kirim `\x03` → `null`.
  - Setelah resolve atau reject: `setRawMode` terakhir dipanggil dengan `false`, output memuat `\x1b[?25h`.
  - `ask` hidden: kirim `s`,`e`,`c`,`\r` → `'sec'` dan output tidak memuat `sec`.
  - `ask` dengan default `'60'`, kirim `\r` → `'60'`.
  - `columns: 40`, label 120 karakter → setiap baris output yang ditulis ≤ 40 karakter terlihat (setelah membuang escape ANSI).
  - 30 item, `rows: 10`, tekan ↓ 25 kali lalu Enter → index 25 dan render terakhir memuat label item 25.
- [ ] **Step 2: Run** `node --import tsx --test test/tui.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** dengan `readline.emitKeypressEvents(t.input)`, raw mode selama menunggu tombol, render ulang di tempat (`\x1b[<n>A` + `\x1b[2K`), kursor disembunyikan selama select. Hapus listener keypress di `finally`.
- [ ] **Step 4: Run** test — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: arrow-key select and prompt primitives"`

### Task 5: Tambah, daftar, hapus koneksi, dan `dbc <nama>`

**Files:**
- Create: `src/add.ts`
- Modify: `src/cli.ts`
- Test: `test/add.test.ts`, `test/cli.test.ts` (tambah test baru saja)

**Interfaces:**
- Consumes: Task 1, 2, 4; `deps.createAdapter` dari `cli.ts`.
- Produces:
  - `interface AddDeps { term: Term | null; storePath: string; createAdapter(c: ConnectionConfig): Promise<DbAdapter>; out: { write(s: string): void } }` — `term === null` berarti non-interaktif.
  - `testConnection(d: AddDeps, c: SavedConnection): Promise<{ version: string } | { error: string }>` — konek, `info()`, tutup; error sudah diredaksi.
  - `addManual(d: AddDeps): Promise<SavedConnection | null>` — tanya jenis (select postgres/mysql), nama, host (`localhost`), port (default jenis), user (default jenis), password (hidden), database, ssl (kosong); uji koneksi; gagal → `confirm('Tetap simpan?')`; nama ada → `confirm` timpa.
  - `addFromEnv(d: AddDeps, path: string): Promise<SavedConnection[]>` — `path` folder → `<path>/.env`; lebih dari satu kandidat → select satu atau "Semuanya"; jenis null → select; nama default `defaultName`, bisa diubah lewat `ask`. Non-interaktif: simpan semua yang jenisnya diketahui, lewati yang null dengan peringatan, tidak menimpa nama yang ada.
  - `cli.ts`: argv[0] `add` (`--env [FILE|DIR]`), `list`, `remove [nama]`; positional tanpa `://` → koneksi tersimpan, laporan lengkap seperti mode URL (opsi berlaku); nama tidak ada → exit 2 dengan pesan Indonesia. `main` menerima `io.stdin` opsional dan `deps.storePath` opsional (default `storePath(env)`).

- [ ] **Step 1: Write the failing tests:**
  - `addFromEnv` non-interaktif pada fixture Task 1 → 3 entri tersimpan dengan `version` dari `fakeAdapter.info()`; kandidat ber-type null dilewati dan pesan peringatan ditulis ke `out`.
  - `addFromEnv` saat `createAdapter` reject dengan pesan memuat password → non-interaktif tidak menyimpan entri itu dan `out` tidak memuat password.
  - `addManual` dengan input tombol tersusun → entri tersimpan dengan field yang dimasukkan; password tidak ada di output.
  - `main(['list'])` → output memuat nama dan host, tidak memuat password.
  - `main(['prod'])` dengan store berisi `prod` → exit 0, laporan dicetak, `createAdapter` menerima config hasil `connectionUrl`; `main(['nope'])` → exit 2, stderr memuat `nope`.
  - `main(['remove','prod'])` tanpa stdin TTY dan tanpa `--yes` → exit 2, pesan meminta `--yes`, `prod` masih ada; `main(['remove','prod','--yes'])` → exit 0, `prod` terhapus. (Konfirmasi interaktif memakai `confirm` saat stdin TTY.)
  - Semua test lama di `test/cli.test.ts` tetap lulus tanpa diubah.
- [ ] **Step 2: Run** `npm test` — Expected: test baru FAIL.
- [ ] **Step 3: Implement.** Semua pesan error lewat `redact` yang ada, dengan `connectionUrl(c)` sebagai URL kandidat.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: dbc add, list, remove and analysis by saved name"`

### Task 6: Menu interaktif

**Files:**
- Create: `src/menu.ts`
- Modify: `src/cli.ts` (argv kosong + stdin/stdout TTY → `runMenu`)
- Test: `test/menu.test.ts`

**Interfaces:**
- Consumes: Task 1–5, `buildReport`, `renderTerminal`, `renderMarkdown`.
- Produces:
  - `interface MenuDeps { term: Term; env: Record<string, string | undefined>; cwd: string; storePath: string; version: string; createAdapter(c: ConnectionConfig): Promise<DbAdapter>; now(): Date; onInterrupt(cb: () => void): () => void }` — `onInterrupt` mendaftarkan handler SIGINT saat analisa berjalan dan mengembalikan fungsi pelepas.
  - `runMenu(d: MenuDeps): Promise<number>` — exit code 0 saat keluar normal.

Perilaku mengikuti spec bagian Layar 1, Layar 2, dan Setelah laporan tampil. Pemetaan pilihan ke `parts`:
- Laporan lengkap: semua bagian
- Query paling lambat: `['statements']`
- Saran index: `['suggestions']`
- Kondisi sekarang: `['running', 'locks']`
- Pantau perubahan: `['statements', 'suggestions']` + `watchSeconds` dari `ask` (default `60`, harus bilangan bulat positif)
- Kesehatan index: `['tableScans', 'foreignKeys', 'unusedIndexes']`

- [ ] **Step 1: Write the failing tests** (input tombol tersusun, `fakeAdapter`, temp dir untuk `cwd` dan store, `now` tetap `2026-10-17T09:05`):
  - Store berisi `prod`; Enter (prod) → Enter (Laporan lengkap) → Enter (Simpan ke .md) → Enter (nama default) → file `<cwd>/prod-20261017-0905.md` ada dan diawali `# Laporan db-checkup`; lalu ↓×6 + Enter (Kembali) → q → exit 0; `close()` dipanggil tepat sekali.
  - `cwd` dengan `.env` berisi `DATABASE_URL=postgres://u:p@h/shop` yang belum tersimpan → baris pertama layar 1 memuat `dari .env`; memilihnya tidak menulis store.
  - Baris `dari .env` → layar 2 punya pilihan "Simpan koneksi ini"; memilihnya menulis entri ke store dengan nama default `defaultName`.
  - `env.DATABASE_URL` diset → baris memuat `dari env DATABASE_URL`.
  - "Pakai connection string sekali" → `ask` URL → analisa jalan, store tidak berubah.
  - Setelah laporan, "Jalankan lagi" → analisa yang sama dijalankan ulang tanpa konek ulang (`createAdapter` dipanggil sekali).
  - Store dan `.env` tidak ada → output memuat petunjuk tambah koneksi; Enter langsung membuka submenu tambah.
  - Store rusak → pesan error tampil, menu tetap jalan, store tidak berubah.
  - `createAdapter` reject dengan pesan memuat password → kembali ke layar 1, output tidak memuat password.
  - Pantau perubahan, jeda `3`; `onInterrupt` callback dipicu saat `onTick` pertama → output memuat `Dibatalkan`, kembali ke layar 2 (pilihan berikutnya Kembali + q berhasil), exit 0.
  - `createAdapter` mengembalikan adapter yang `info()`-nya throw setelah terhubung → `close()` tetap dipanggil, `setRawMode(false)` terakhir, exit 0 setelah q.
  - Nama koneksi `a/b` → nama file default `a-b-20261017-0905.md`.
  - `d` pada `prod` + konfirmasi `y` → `prod` hilang dari store; `d` pada baris `dari .env` tidak melakukan apa pun.
- [ ] **Step 2: Run** `node --import tsx --test test/menu.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/menu.ts`; hubungkan di `cli.ts` dengan `process.stdin`/`process.stdout`, `onInterrupt` memakai `process.on('SIGINT')`.
- [ ] **Step 4: Run** `npm test` — Expected: semua PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: interactive dbc menu"`

### Task 7: Paket, installer, dokumentasi, dan uji nyata

**Files:**
- Modify: `package.json`, `install.sh`, `README.md`

- [ ] **Step 1:** `package.json` `bin`: `{"dbc": "dist/cli.js", "db-checkup": "dist/cli.js"}`. `--help` (USAGE) menyebut `dbc`, subcommand baru, dan bahwa tanpa argumen di terminal membuka menu.
- [ ] **Step 2:** `install.sh`: pesan akhir menjalankan `dbc --version` dan menyebut `dbc`; cek PATH memakai `dbc`. `--uninstall` tetap `npm uninstall -g db-checkup` (menghapus kedua bin).
- [ ] **Step 3:** README (bahasa Indonesia): bagian "Menu interaktif (`dbc`)" di atas pemakaian lama: menjalankan `dbc`, tambah dari `.env`, file koneksi bersama `dbb` (`~/.dbb/databases.json`, izin 600, field `ssl`), subcommand, Ctrl-C.
- [ ] **Step 4: Verify** `npm test && npm run build` lulus. Dengan container compose `db-checkup` (pg16 di 54316, mysql80 di 33080):
  - `DBB_CONFIG=<scratch>/db.json node dist/cli.js add --env <scratch dengan .env berisi DATABASE_URL=postgres://postgres:test@localhost:54316/postgres>` → tersimpan dengan `version`.
  - `DBB_CONFIG=... node dist/cli.js list` lalu `node dist/cli.js <nama>` → exit 0, laporan.
  - Menu sungguhan lewat pseudo-terminal: `script -q /dev/null node dist/cli.js` (macOS) dengan input tombol dari pipe, pilih koneksi → Kondisi sekarang → Simpan → q; file `.md` terbentuk, `stty -a` setelahnya menunjukkan `icanon echo` (terminal normal).
  - `install.sh` dengan `NPM_CONFIG_PREFIX` sementara → `dbc --version` jalan.
- [ ] **Step 5: Commit** `git commit -m "feat: ship dbc command and document the interactive menu"`
