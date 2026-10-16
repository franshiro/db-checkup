# db-checkup — Dokumen Desain

Tanggal: 2026-10-17

## 1. Latar belakang dan tujuan

Website pemilik proyek memakai Postgres dan MySQL. Beberapa waktu terakhir sering terjadi query lambat dan timeout. Saat ini cara mencari penyebab hanya dengan membaca log aplikasi, dan dari situ tidak terlihat query mana yang lambat. Setelah query lambat ketemu, langkah perbaikan yang biasa dilakukan adalah menambah index, tapi pemilik proyek tidak tahu index apa yang dibutuhkan.

`db-checkup` adalah tools CLI yang konek ke satu database, membaca statistik bawaan database, lalu menampilkan:

1. query mana yang paling lambat atau paling berat,
2. perintah `CREATE INDEX` yang disarankan untuk query tersebut,
3. masalah index di level tabel,
4. kondisi saat ini (query yang sedang jalan lama dan query yang saling mengunci).

Hasilnya bisa disimpan ke file Markdown untuk dibagikan ke tim.

**Sukses berarti:** saat website timeout, pemilik proyek menjalankan satu perintah, dalam beberapa detik tahu query penyebabnya, dan mendapat perintah index yang bisa langsung dicoba.

## 2. Goals

- Mendukung **Postgres** dan **MySQL** dengan satu perintah yang sama.
- Bisa dijalankan **langsung di server** atau **dari laptop lokal** lewat jaringan.
- Mendukung database di server sendiri dan di cloud (koneksi SSL).
- Menampilkan hasil di terminal, dan opsional menyimpan ke file Markdown.
- Memberi saran index dalam bentuk perintah SQL siap pakai, dengan tingkat keyakinan.
- Kalau fitur statistik database belum aktif, memberi instruksi jelas cara mengaktifkannya.

## 3. Non-goals (tidak dikerjakan di versi pertama)

- Monitoring terus-menerus, daemon, atau agent di background.
- Dashboard web.
- Menganalisa beberapa database dalam satu perintah.
- Membuat index atau mengubah apa pun secara otomatis.
- Membaca log aplikasi atau slow query log berbasis file.
- Saran tuning konfigurasi server (memori, `work_mem`, `innodb_buffer_pool_size`, dan sejenisnya).
- Saran menulis ulang query.
- Membandingkan hasil dengan run sebelumnya (histori).
- Dukungan penuh MySQL 5.7.

## 4. Anti-goals (gagal walaupun secara teknis jalan)

- **Tools memperberat database production** yang sedang bermasalah. Contoh: query statistik berat, query yang mengambil lock, atau benar-benar mengeksekusi query lambat.
- **Tools mengubah apa pun** di database: data, setting, extension, atau index.
- **Report membocorkan data sensitif** saat dibagikan, misalnya password atau data pelanggan di dalam teks query.
- **Saran index terdengar yakin padahal salah.** Setiap saran wajib punya label keyakinan dan alasan singkat.

## 5. Keputusan pemilik proyek

- Bentuk: **CLI**, bukan dashboard.
- Bahasa: **Node.js + TypeScript**. Semua server sudah memakai Node.js.
- Distribusi: **paket npm** (`npm install -g db-checkup` atau `npx db-checkup`). Tidak perlu binary.
- **Satu database per perintah.**
- Saran index **hanya ditampilkan**. Tools tidak membuat index.
- Hasil bisa **disimpan ke file** untuk dibagikan ke tim.
- Pemilik proyek punya akses admin ke semua database. Sebagian database berjalan di server sendiri, sebagian di cloud.
- Versi Postgres dan MySQL yang dipakai **belum diketahui**. Ada kemungkinan sebagian "MySQL" sebenarnya MariaDB.
- Peringkat query lambat: **akumulasi sebagai default, plus mode snapshot "saat ini" lewat `--watch`** (opsi rekomendasi desainer, disetujui pemilik proyek).

## 6. Keputusan desainer (bisa diganti pemilik proyek)

- Versi yang didukung: **Postgres 12+** dan **MySQL 8.0+**. Tools mendeteksi versi saat konek dan menyesuaikan fitur. MySQL 5.7 boleh tetap dicoba, tapi tools memberi peringatan dan melewati analisa yang tidak didukung.
- **MariaDB didukung dasar.** Tools mendeteksi MariaDB dari string versi dan menampilkan peringatan di ringkasan. Yang tetap jalan: daftar query lambat dari `events_statements_summary_by_digest` (kalau `performance_schema` aktif; di MariaDB default-nya mati), query yang sedang jalan, dan lock (kalau view yang dibutuhkan ada). MariaDB tidak punya `QUERY_SAMPLE_TEXT`, jadi saran index selalu memakai jalur analisa teks berkeyakinan rendah. Analisa yang butuh schema `sys` dilewati kalau schema itu tidak ada. Semua yang dilewati dicatat di ringkasan dengan alasannya.
- Versi Node minimal: **Node 20**.
- Format file report: **Markdown**.
- Literal di dalam teks query **disamarkan secara default**.
- Nama paket dan perintah: `db-checkup` (sama dengan nama folder). Ketersediaan nama di npm belum dicek.

## 7. Antarmuka CLI

```
db-checkup [connection-url] [options]
```

- `connection-url`: `postgres://…` / `postgresql://…` atau `mysql://…`. Jenis database dibaca dari scheme.
- Kalau argumen tidak diberikan, tools membaca environment variable `DATABASE_URL`. Ini supaya password tidak masuk shell history.
- Opsi SSL diberikan lewat parameter connection string standar driver (misalnya `?sslmode=require` untuk Postgres).

Opsi:

| Opsi | Default | Fungsi |
|------|---------|--------|
| `--output <file>` | tidak ada | Simpan report ke file Markdown. Terminal tetap menampilkan hasil. |
| `--top <n>` | 10 | Jumlah query lambat yang ditampilkan. |
| `--watch <detik>` | tidak aktif | Ambil dua snapshot statistik query dengan jeda `<detik>`, lalu tampilkan juga peringkat berdasarkan selisihnya (lihat 9.1). |
| `--no-mask` | mask aktif | Tampilkan nilai asli di dalam query. |
| `--help`, `--version` | | Standar. |

Exit code: `0` kalau analisa selesai (walaupun ada temuan), selain `0` kalau gagal konek atau error fatal.

## 8. Keamanan saat berjalan di production

Tools wajib aman dijalankan saat database sedang bermasalah:

- Session dibuat **read-only**:
  - Postgres: `SET default_transaction_read_only = on`.
  - MySQL: `SET SESSION TRANSACTION READ ONLY`.
- Setiap query tools punya **batas waktu** pendek (`statement_timeout` untuk Postgres, `max_execution_time` untuk MySQL). Kalau satu analisa kena batas waktu, analisa itu dilewati dengan catatan di report, dan analisa lain tetap jalan.
- Tools **tidak pernah** menjalankan `EXPLAIN ANALYZE`. Tools hanya menjalankan `EXPLAIN` biasa, yang tidak mengeksekusi query.
- `EXPLAIN` hanya dijalankan untuk statement yang diawali `SELECT` atau `WITH`. Statement lain (`INSERT`, `UPDATE`, `DELETE`, DDL) tetap ditampilkan di daftar query lambat, tapi tidak di-`EXPLAIN`.
- Tools memakai satu koneksi saja.
- Tools tidak menjalankan `CREATE EXTENSION`, tidak mengubah setting, dan tidak mereset statistik.

## 9. Isi analisa

Urutan bagian di report:

### 9.0 Ringkasan koneksi

Jenis dan versi database, nama database, host (password disamarkan), waktu analisa, dan **sejak kapan statistik dikumpulkan**. Contoh: Postgres 14+ punya `pg_stat_statements_info.stats_reset`, dan MySQL bisa memakai uptime server. Info ini penting, karena angka statistik adalah akumulasi sejak reset terakhir.

Daftar analisa yang dilewati beserta alasannya (fitur tidak aktif, versi tidak mendukung, hak akses kurang, kena timeout).

### 9.1 Query paling lambat

Top N query diurutkan berdasarkan **total waktu eksekusi**. Per query ditampilkan: teks query (sudah dinormalisasi atau disamarkan), jumlah eksekusi, total waktu, rata-rata waktu, dan jumlah baris.

- **Postgres:** `pg_stat_statements`. Nama kolom berbeda antar versi: `total_time`/`mean_time` di PG12, `total_exec_time`/`mean_exec_time` di PG13+.
- **MySQL:** `performance_schema.events_statements_summary_by_digest`. Kolom yang dipakai: `DIGEST_TEXT`, `COUNT_STAR`, `SUM_TIMER_WAIT`, `AVG_TIMER_WAIT` (dalam picosecond), `SUM_ROWS_EXAMINED`, `SUM_ROWS_SENT`, `SUM_NO_INDEX_USED`, dan `QUERY_SAMPLE_TEXT`.
- Sinyal tambahan yang ditampilkan kalau ada: rasio baris yang diperiksa dibanding baris yang dikembalikan (MySQL), dan penanda "tidak memakai index".
- Query milik tools sendiri dan query sistem tidak dimasukkan ke daftar.

**Dua jenis peringkat:**

- **Akumulasi (selalu ditampilkan):** total sejak statistik terakhir direset. Cepat, tapi query yang baru mulai lambat bisa tenggelam di bawah query lama.
- **Saat ini (hanya dengan `--watch <detik>`):** tools mengambil snapshot statistik, menunggu `<detik>`, mengambil snapshot kedua, lalu mengurutkan berdasarkan selisih total waktu. Query dicocokkan antar snapshot lewat `queryid` (Postgres) atau `DIGEST` + `SCHEMA_NAME` (MySQL). Query yang muncul pertama kali di snapshot kedua dihitung dari nol. Selama menunggu, tools menampilkan hitung mundur. Bagian ini ditampilkan di atas peringkat akumulasi, karena paling relevan saat timeout sedang terjadi. Bagian 9.2 memakai gabungan query dari kedua peringkat.
- Snapshot dibaca dari tabel statistik biasa. Tools tidak mereset statistik dan tidak menyimpan apa pun antar run, jadi tetap sesuai bagian 3 dan 8.

**Kalau fitur statistik tidak aktif:** tampilkan instruksi cara mengaktifkannya, untuk server sendiri dan untuk cloud. Contoh: `shared_preload_libraries` + `CREATE EXTENSION pg_stat_statements` untuk Postgres di server sendiri, parameter group di AWS RDS, database flags di Google Cloud SQL, dan `performance_schema = ON` untuk MySQL. Bagian lain tetap jalan.

### 9.2 Saran index per query lambat

Untuk setiap query di 9.1 yang bisa di-`EXPLAIN`:

- **Postgres 16+:** `EXPLAIN (FORMAT JSON, GENERIC_PLAN)` pada teks query yang memakai parameter `$1`.
- **Postgres 12–15:** `PREPARE` query, `SET plan_cache_mode = force_generic_plan` (hanya di level session), lalu `EXPLAIN (FORMAT JSON) EXECUTE` dengan parameter `NULL`, lalu `DEALLOCATE`. Hasilnya generic plan tanpa mengeksekusi query, setara `GENERIC_PLAN` di PG16. Ini perubahan setting session saja, sama seperti `statement_timeout`, jadi tidak melanggar bagian 8. *(Keputusan desainer.)*
- **MySQL:** `EXPLAIN FORMAT=JSON` pada `QUERY_SAMPLE_TEXT`. Query tidak di-`EXPLAIN` kalau sampel terpotong (panjangnya mencapai `performance_schema_max_sql_text_length`), kosong, atau berisi placeholder `?` (terjadi kalau aplikasi memakai server-side prepared statement, misalnya `mysql2` `execute()`).
- **Kalau tidak bisa di-`EXPLAIN`:** saran dibuat dari analisa teks SQL dan statistik tabel (9.3), dengan keyakinan maksimal "rendah". Report memberi catatan alasannya. *(Keputusan desainer.)*

Aturan saran:

1. Cari node rencana eksekusi berupa scan seluruh tabel (`Seq Scan` di Postgres, `access_type: ALL` di MySQL) pada tabel besar. Ambang default: lebih dari 10.000 baris.
2. Ambil kolom dari kondisi filter dan join tabel tersebut. Susun index komposit dengan urutan: kolom kondisi sama-dengan dulu, lalu kolom range, lalu kolom `ORDER BY`.
3. Jangan sarankan index kalau index yang ada sudah diawali kolom yang sama.
4. Keluarkan perintah siap pakai:
   - Postgres: `CREATE INDEX CONCURRENTLY idx_<tabel>_<kolom> ON <tabel> (<kolom>);`
   - MySQL: `CREATE INDEX idx_<tabel>_<kolom> ON <tabel> (<kolom>) ALGORITHM=INPLACE, LOCK=NONE;`
5. Setiap saran punya **keyakinan** (tinggi / sedang / rendah) dan **satu kalimat alasan**. Contoh: "Seq Scan pada `orders` (2,1 juta baris), filter `customer_id = $1`."
6. Report selalu mengingatkan: uji index dulu di staging, dan bahwa index menambah beban `INSERT` dan `UPDATE`.

### 9.3 Masalah index di level tabel

- **Tabel yang sering di-scan penuh.** Postgres: `pg_stat_user_tables` (`seq_scan`, `seq_tup_read`, `n_live_tup`). MySQL: `sys.schema_tables_with_full_table_scans`.
- **Foreign key tanpa index.** Hanya Postgres, dari `pg_constraint` dibanding `pg_index`. Bagian ini dilewati untuk MySQL, karena InnoDB otomatis membuat index untuk foreign key.
- **Index yang tidak pernah dipakai.** Postgres: `pg_stat_user_indexes.idx_scan = 0`, kecuali index primary key dan unique. MySQL: `sys.schema_unused_indexes`. Beri catatan bahwa hasil ini hanya berlaku sejak statistik terakhir direset.

### 9.4 Kondisi saat ini

- **Query yang sedang jalan lama** (default lebih dari 5 detik). Postgres: `pg_stat_activity`. MySQL: `performance_schema.processlist` atau `information_schema.PROCESSLIST`.
- **Query yang saling mengunci.** Tampilkan siapa yang menunggu dan siapa yang memblokir. Postgres: `pg_blocking_pids()`. MySQL: `sys.innodb_lock_waits`.
- Tools hanya menampilkan informasi. Tools tidak menghentikan query apa pun.

## 10. Penyamaran data (masking)

Report dirancang aman untuk dibagikan.

- **Password** di connection string selalu disamarkan, di terminal maupun di file. Tidak ada opsi untuk mematikan ini.
- **Literal di dalam query** (string dan angka) diganti `?` secara default. Contoh: `WHERE email = 'budi@x.com'` menjadi `WHERE email = ?`. Ini berlaku untuk semua teks query yang ditampilkan: `QUERY_SAMPLE_TEXT` MySQL, query yang sedang berjalan, dan query yang saling mengunci.
- Teks query asli tetap boleh dipakai **secara internal** untuk `EXPLAIN`, tapi tidak pernah ditampilkan kalau masking aktif.
- `--no-mask` mematikan penyamaran literal.
- Kalau penyamaran ragu-ragu, misalnya karena SQL tidak bisa di-parse, lebih baik samarkan terlalu banyak daripada terlalu sedikit.

## 11. Hak akses yang dibutuhkan

Report menyebutkan kalau hak akses kurang dan hasil jadi tidak lengkap.

- **Postgres:** role dengan `pg_read_all_stats` (atau superuser) agar bisa melihat query milik user lain.
- **MySQL:** `SELECT` pada `performance_schema` dan `sys`, plus privilege `PROCESS`.

## 12. Output

- **Terminal:** setiap bagian punya judul dan tabel yang mudah dibaca. Warna dipakai untuk menandai tingkat keparahan, dan otomatis mati kalau output bukan TTY.
- **File Markdown** (`--output`): isi sama dengan terminal, dalam bentuk heading dan tabel Markdown. Perintah `CREATE INDEX` ditaruh di blok kode supaya mudah di-copy.
- Bagian yang tidak punya temuan tetap ditampilkan dengan tulisan "tidak ada temuan". Dengan begitu pembaca tahu bagian itu sudah dicek.

## 13. Diserahkan ke builder

- Struktur kode, library CLI, library tabel dan warna terminal.
- Cara mem-parse SQL untuk mengambil kolom dan untuk masking. Library seperti `node-sql-parser` atau parsing berbasis rencana `EXPLAIN` sama-sama boleh.
- Driver database. Rekomendasi: `pg` dan `mysql2`.
- Nilai pasti batas waktu per query tools, selama masih pendek (beberapa detik).
- Cara pengujian. Harapan minimal: diuji terhadap Postgres 12, Postgres 16+, dan MySQL 8.0 yang sungguhan (misalnya lewat Docker) dengan data dan query lambat buatan.
