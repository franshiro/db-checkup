# Desain: analisa konfigurasi server database

Tanggal: 2026-10-17. Melanjutkan [desain db-checkup](2026-10-17-db-checkup-design.md) dan [desain dbc](2026-10-17-dbc-interactive-design.md). Semua jaminan di sana tetap berlaku: hanya membaca, password selalu disamarkan, perintah perbaikan hanya ditampilkan dan tidak pernah dijalankan.

## Maksud dan alasan

Masalah yang dialami pengguna bukan hanya query lambat. `max_connections` sering penuh, memori server habis sampai server melambat, dan beberapa setting yang dibutuhkan analisa (mis. `pg_stat_statements`) belum aktif. Pengguna tidak tahu apakah memori yang habis itu RAM server atau proses database, dan tidak tahu angka setting yang tepat. Fitur ini membaca setting dan kondisi koneksi database, membandingkannya dengan RAM server, lalu memberi angka rekomendasi konkret beserta perintah untuk mengubahnya.

Sukses berarti: dari satu laporan pengguna tahu (1) apakah setting memori database bisa melebihi RAM yang tersedia, (2) siapa yang menghabiskan koneksi, (3) setting apa yang belum aktif untuk analisa, dan (4) angka berapa yang harus dipasang, dengan perintah siap salin.

## Tujuan

- Bagian laporan baru "Konfigurasi server", di menu `dbc` (layar 2), di "Laporan lengkap", dan di mode CLI.
- Rekomendasi angka konkret berdasarkan jatah RAM untuk database.
- Perintah perubahan per platform (server sendiri, AWS RDS, Google Cloud SQL), dengan tanda "perlu restart".

## Bukan tujuan

- Mengubah config atau menjalankan perintah apa pun di server.
- Tuning untuk beban kerja khusus (data warehouse, replikasi, partisi) atau setting di luar daftar di bawah.
- Membaca file config (`postgresql.conf`, `my.cnf`) langsung; semua dibaca lewat koneksi database.
- Memantau memori dari waktu ke waktu.

## Anti-tujuan

- Rekomendasi yang membuat server lebih buruk: angka yang membuat perkiraan memori terburuk melebihi jatah RAM, atau saran menaikkan `max_connections` saat memori sudah tidak cukup.
- Saran yang tidak bisa dijalankan di platformnya (mis. `ALTER SYSTEM` untuk RDS).
- Laporan penuh rekomendasi kecil yang tidak penting.

## Menentukan jatah RAM

- **Server khusus database atau berbagi dengan aplikasi.** Jatah RAM database: khusus = 100% RAM, berbagi = 50% RAM. *(Angka 50% keputusan Claude; bisa diubah pengguna.)*
- **Besar RAM.** Kalau host koneksi adalah `localhost`, `127.0.0.1`, `::1`, atau Unix socket, RAM dibaca dari mesin tempat `dbc` jalan dengan `os.totalmem()`. "RAM tersedia" hanya ditampilkan di Linux, dari `MemAvailable` di `/proc/meminfo` (di macOS `os.freemem()` tidak menghitung cache, jadi menyesatkan). Selain itu RAM ditanyakan.
- **Menu.** Pertama kali "Konfigurasi server" atau "Laporan lengkap" dijalankan untuk koneksi tersimpan yang belum punya info server, `dbc` bertanya "Server ini khusus database?" (Ya / Berbagi dengan aplikasi) dan "Besar RAM server (mis. 8G)". Untuk host lokal, pertanyaan RAM diisi default dengan angka yang terbaca ("16G terbaca dari mesin ini"), karena `localhost` bisa saja tunnel SSH atau port Docker ke server lain *(keputusan Claude)*. Jawaban disimpan di entri koneksi sebagai field opsional `dedicated` (boolean) dan `ram_mb` (bilangan bulat, hanya kalau ditanya). `dbb` mengabaikan field ini. Untuk baris "dari .env", "dari env", dan connection string sekali pakai, pertanyaan diajukan setiap kali dan tidak disimpan. Jawaban bisa diubah dari layar 2 ("Ubah info server") *(keputusan Claude)*.
- **CLI.** `--ram <ukuran>` (mis. `8G`, `512M`), `--shared`, dan `--dedicated`. Urutan prioritas *(keputusan Claude)*: RAM = `--ram` > `ram_mb` tersimpan > dibaca otomatis (host lokal) > tidak diketahui; jenis server = `--shared`/`--dedicated` > `dedicated` tersimpan > khusus database. CLI tidak pernah menyimpan ke file koneksi. Kalau RAM tetap tidak diketahui, rekomendasi memori dilewati dengan pesan "RAM server tidak diketahui, pakai --ram", bagian lain tetap jalan.
- **Batasan.** Kalau database jalan di Docker atau VM di mesin yang sama, atau `localhost` adalah tunnel ke server lain, RAM yang terbaca bukan RAM database. Laporan selalu menulis sumber angka RAM ("dibaca dari mesin ini" / "diisi manual" / "--ram") supaya pengguna bisa menilai.
- **File koneksi.** Field `dedicated` atau `ram_mb` yang tidak valid (bukan boolean / bukan bilangan bulat positif) diabaikan saat dibaca (dianggap belum diisi) dan dibiarkan apa adanya di file; entri tetap valid. Saat koneksi ditimpa ("timpa"), `dedicated` dan `ram_mb` ikut dipertahankan seperti `bulk`, kecuali host atau port berubah: keduanya dibuang karena kemungkinan server lain *(keputusan Claude)*.

## Isi bagian "Konfigurasi server"

Setiap temuan berisi: setting, nilai sekarang, nilai disarankan, alasan, dan apakah perlu restart. Perintah dikumpulkan di blok kode per platform di akhir bagian.

### 1. Koneksi

- Batas `max_connections`, jumlah koneksi sekarang, persentase. Postgres: dihitung untuk seluruh server (semua database), hanya `backend_type = 'client backend'`; batas efektif = `max_connections` − `superuser_reserved_connections` − `reserved_connections` (PG16+). MySQL: jumlah dari `Threads_connected`.
- Rincian koneksi dikelompokkan per database, user, aplikasi (Postgres `application_name`; MySQL host tanpa port), dan status. MySQL tanpa hak `PROCESS` hanya melihat koneksinya sendiri: rincian ditandai "sebagian (butuh PROCESS)". Ditandai: `idle` lebih dari 10 menit, dan `idle in transaction` lebih dari 1 menit (Postgres; menahan lock).
- MySQL: `Max_used_connections` (puncak sejak restart) dan `Connection_errors_max_connections` (berapa kali koneksi ditolak karena penuh).
- Peringatan kalau pemakaian sekarang atau puncak ≥ 80% dari batas.
- Rekomendasi saat penuh atau hampir penuh:
  - Postgres: pasang connection pooler (PgBouncer, mode transaction) dan kurangi pool aplikasi; jangan menaikkan `max_connections` kecuali perkiraan memori terburuk (bagian 2) dengan nilai baru masih di bawah jatah RAM. Kalau banyak `idle in transaction`: `idle_in_transaction_session_timeout = '60s'`.
  - MySQL: kalau banyak `Sleep` lebih dari 10 menit, `wait_timeout = 600` (dan `interactive_timeout`). Menaikkan `max_connections` hanya kalau memori masih cukup, dengan angka yang dihitung.

### 2. Memori

Perkiraan memori terburuk database:
- Postgres: `shared_buffers` + `max_connections` × `work_mem` + `autovacuum_max_workers` × (`autovacuum_work_mem`, atau `maintenance_work_mem` kalau -1).
- MySQL/MariaDB: `innodb_buffer_pool_size` + `key_buffer_size` (+ `aria_pagecache_buffer_size` di MariaDB) + `max_connections` × (`sort_buffer_size` + `join_buffer_size` + `read_buffer_size` + `read_rnd_buffer_size` + `thread_stack` + `binlog_cache_size`).

Ditampilkan bersama total RAM, RAM tersedia (kalau lokal), dan jatah RAM. Kalau perkiraan terburuk > jatah RAM: peringatan "Dalam kondisi terburuk, setting memori bisa melebihi RAM", selalu tampil. Ini perkiraan pesimis (semua koneksi memakai buffer maksimal bersamaan), dan teksnya menyebut itu.

Rekomendasi (J = jatah RAM, dibulatkan ke MB, ditulis dengan satuan `MB`/`GB`):

| Setting | Rumus |
|---|---|
| Postgres `shared_buffers` | 25% J |
| Postgres `effective_cache_size` | 75% J |
| Postgres `work_mem` | (J − `shared_buffers` disarankan) ÷ (`max_connections` × 3), minimal 4MB |
| Postgres `maintenance_work_mem` | 5% J, maksimal 2GB, minimal 64MB |
| MySQL `innodb_buffer_pool_size` | 70% J − `max_connections` × memori per koneksi (rumus di atas), minimal 128MB, dibulatkan ke bawah ke kelipatan 128MB (MySQL bisa membulatkan lagi sesuai `innodb_buffer_pool_chunk_size` × instances; laporan menyebutnya) |

Rumus mengikuti pedoman umum (PGTune, dokumentasi MySQL). Urutan perhitungan *(keputusan Claude)*:

1. Hitung set rekomendasi R dari tabel di atas, dengan `max_connections` sekarang.
2. Hitung perkiraan terburuk dengan R. Kalau > J: turunkan `work_mem` (Postgres) atau buffer pool (MySQL) sampai muat, tidak di bawah batas bawah.
3. Kalau tetap tidak muat: rekomendasikan `max_connections` baru = nilai terbesar yang membuat perkiraan terburuk dengan batas bawah tersebut ≤ J, dibulatkan ke bawah ke kelipatan 10, plus saran pooler. Kalau hasilnya < 20, jangan beri rekomendasi memori; tampilkan "RAM terlalu kecil untuk setting minimal" dengan angka J.
4. Tampilkan sebuah setting kalau nilai sekarang di bawah 50% atau di atas 150% dari nilainya di R, atau kalau setting itu diubah di langkah 2–3 dan perkiraan terburuk dengan nilai sekarang > J *(ambang 50–150%: keputusan Claude)*.

Perkiraan terburuk dengan nilai yang disarankan ditampilkan di bawah tabel rekomendasi, supaya terlihat bahwa sudah muat.

### 3. Kesiapan untuk analisa

Dicek dan, kalau belum sesuai, diberi langkah mengaktifkan:
- Postgres: `pg_stat_statements` ada di `shared_preload_libraries` dan extension sudah dibuat; `track_io_timing = on`; `track_activity_query_size` ≥ 4096; `log_min_duration_statement` diset (mis. `1000` ms) untuk log query lambat.
- MySQL/MariaDB: `performance_schema = ON` (perlu restart); consumer `statements_digest` aktif; `slow_query_log = ON` dengan `long_query_time` (mis. 1 detik).

### 4. Versi

Versi mayor ditandai kalau sudah end-of-life atau berakhir dalam 6 bulan, dari tabel tanggal yang ditulis di kode beserta tanggal tabel itu diperbarui. Data per 2026-10-17:
- Postgres: 12 berakhir 2024-11, 13 → 2025-11, 14 → 2026-11, 15 → 2027-11, 16 → 2028-11, 17 → 2029-11, 18 → 2030-11.
- MySQL: 5.7 berakhir 2023-10, 8.0 → 2026-04, 8.4 LTS → 2032-04.
- MariaDB: 10.6 berakhir 2026-07, 10.11 → 2028-02, 11.4 → 2029-05.

Versi yang tidak ada di tabel: tidak ditandai.

## Perintah per platform

- **Postgres, server sendiri:** `ALTER SYSTEM SET <setting> = '<nilai>';` lalu `SELECT pg_reload_conf();`, atau restart untuk setting yang butuh restart (`context = 'postmaster'` di `pg_settings`).
- **Postgres, catatan:** `ALTER SYSTEM` butuh superuser (atau hak `ALTER SYSTEM`/`SET` di PG15+). Tanda "perlu restart" diambil dari `pg_settings.context` per setting, tidak ditulis tetap.
- **MySQL 8+, server sendiri:** `SET PERSIST <setting> = <nilai>;` untuk setting dinamis; untuk setting yang tidak dinamis (mis. `performance_schema`), baris di `my.cnf` bagian `[mysqld]` lalu restart.
- **MariaDB dan MySQL 5.7:** `SET GLOBAL` untuk yang dinamis ditambah baris `my.cnf` supaya bertahan setelah restart. Setting MySQL/MariaDB yang tidak dinamis (`performance_schema`, dan `innodb_buffer_pool_size` di versi yang tidak mendukung ubah langsung) ditulis di tabel kecil di kode.
- **AWS RDS / Google Cloud SQL:** tidak ada perintah SQL; tampilkan nama parameter dan nilainya untuk parameter group (RDS) atau database flags (Cloud SQL), seperti petunjuk `pg_stat_statements` yang sudah ada. Platform tidak dideteksi otomatis; ketiga variasi selalu ditampilkan *(keputusan Claude)*.

## Hak akses

Memakai hak akses yang sudah dibutuhkan sekarang (Postgres `pg_read_all_stats`; MySQL `PROCESS` dan `SELECT` pada `performance_schema`). Bagian yang gagal karena hak akses mengikuti pola isolasi error yang ada: "Dilewati" dengan petunjuk.

## Teks dan tampilan

Bahasa Indonesia, angka format `id-ID`, ukuran memori dengan satuan MB/GB. Laporan Markdown memuat bagian yang sama.

## Diserahkan ke builder

- Struktur kode (adapter baru, modul rumus), selama rumus dan ambang di atas diikuti dan bisa dites tanpa database.
- Urutan tampilan temuan di dalam bagian.
- Tata letak pertanyaan info server di menu.
