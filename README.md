# db-checkup

CLI untuk memeriksa database Postgres dan MySQL/MariaDB: query paling lambat, saran index, tabel yang sering di-scan penuh, index tidak terpakai, serta query yang sedang jalan lama atau saling mengunci.

**Tools ini hanya membaca.** Tidak ada `INSERT`, `UPDATE`, `DDL`, ataupun `KILL`. Saran `CREATE INDEX` hanya ditampilkan, tidak dijalankan.

## Install

```sh
npm install && npm run build && npm install -g .   # dari repo ini
npx db-checkup ...    # setelah dipublish
```

Butuh Node 20.12 atau lebih baru.

## Pemakaian

```sh
db-checkup postgres://user:pass@localhost:5432/shop
db-checkup mysql://user:pass@localhost:3306/shop
DATABASE_URL=postgres://user:pass@host/db db-checkup
db-checkup postgres://user:pass@host/db --watch 60       # bandingkan dua snapshot, jeda 60 detik
db-checkup postgres://user:pass@host/db --output report.md
```

Opsi: `--top <n>` (default 10), `--watch <detik>`, `--output <file>`, `--no-mask`, `--help`, `--version`.

Password di connection string selalu disamarkan. Literal di dalam query (string dan angka) diganti `?` kecuali memakai `--no-mask`.

Exit code: `0` sukses, `1` gagal konek atau error saat analisa, `2` argumen salah.

## Hak akses yang dibutuhkan

Kalau hak akses kurang, bagian terkait dilewati dan alasannya ditulis di report.

- **Postgres:** role dengan `pg_read_all_stats` (atau superuser), dan extension `pg_stat_statements` aktif.
  `GRANT pg_read_all_stats TO <user>;`
- **MySQL:** `SELECT` pada `performance_schema` dan `sys`, plus privilege `PROCESS`.
  ```sql
  GRANT SELECT ON performance_schema.* TO <user>;
  GRANT SELECT ON sys.* TO <user>;
  GRANT PROCESS ON *.* TO <user>;
  ```

Untuk MySQL, tambahkan `?ssl=true` (atau `?ssl=skip-verify`) di connection string kalau server butuh TLS.

Untuk Postgres di cloud (RDS, Cloud SQL), server memakai CA privat. Perhatikan bahwa `sslmode=require` di driver `pg` berarti `verify-full` (sertifikat diverifikasi), jadi koneksi gagal kalau CA tidak dikenal. Pilihannya:

- `?sslmode=verify-full&sslrootcert=/path/ca.pem` (disarankan: terenkripsi dan diverifikasi)
- `?sslmode=no-verify` (terenkripsi, tanpa verifikasi sertifikat)
- `?uselibpqcompat=true&sslmode=require` (perilaku sama dengan libpq/psql: terenkripsi, tanpa verifikasi)
