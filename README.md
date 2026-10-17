# db-checkup

CLI untuk memeriksa database Postgres dan MySQL/MariaDB: query paling lambat, saran index, tabel yang sering di-scan penuh, index tidak terpakai, serta query yang sedang jalan lama atau saling mengunci.

**Tools ini hanya membaca.** Tidak ada `INSERT`, `UPDATE`, `DDL`, ataupun `KILL`. Saran `CREATE INDEX` hanya ditampilkan, tidak dijalankan.

## Install

Butuh Node 20.12 atau lebih baru, dan git.

```sh
curl -fsSL https://raw.githubusercontent.com/franshiro/db-checkup/main/install.sh | bash
```

Script mengunduh repo ke `~/.db-checkup`, build, lalu memasang perintah `dbc` (dan `db-checkup`, nama lama) secara global. Jalankan ulang perintah yang sama untuk update. Folder lain bisa dipilih lewat `DB_CHECKUP_DIR=/opt/db-checkup`. Kalau npm global butuh root, pakai `... | sudo bash`.

Dari repo yang sudah di-clone:

```sh
./install.sh
# atau manual:
npm install && npm run build && npm install -g .
```

### Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/franshiro/db-checkup/main/install.sh | bash -s -- --uninstall
# atau dari repo yang sudah di-clone:
./install.sh --uninstall
```

Perintah `dbc` dan `db-checkup` dihapus, begitu juga folder `~/.db-checkup` (atau `DB_CHECKUP_DIR`) yang dibuat oleh script. Repo yang kamu clone sendiri tidak ikut dihapus.

## Menu interaktif (`dbc`)

Ketik `dbc` di terminal tanpa argumen untuk membuka menu: pilih koneksi dengan panah, pilih jenis analisa, lihat laporan, lalu simpan ke file `.md`. Menu hanya terbuka kalau stdin dan stdout adalah terminal; di cron atau pipe, `dbc` tanpa argumen memakai `DATABASE_URL` seperti sebelumnya.

```sh
dbc
```

- **Layar 1, pilih database:** koneksi tersimpan, ditambah koneksi dari `.env` di folder saat ini atau dari env `DATABASE_URL` kalau belum tersimpan (memilihnya langsung menganalisa tanpa menyimpan). Di bawahnya "+ Tambah koneksi" dan "Pakai connection string sekali".
- **Layar 2, pilih analisa:** Laporan lengkap, Query paling lambat, Saran index, Kondisi sekarang, Pantau perubahan (jeda default 60 detik), Kesehatan index. Bagian yang tidak dipilih tidak dijalankan ke database. Literal di dalam query selalu disamarkan.
- **Setelah laporan:** Simpan ke .md (default `./<nama>-<YYYYMMDD-HHmm>.md`), Jalankan lagi, Kembali ke menu, Keluar.

Tombol: `↑` `↓` atau `j` `k` untuk gerak, Enter untuk memilih, `d` hapus koneksi tersimpan di layar 1 (dengan konfirmasi). `q`, Esc, atau Ctrl-C kembali satu tingkat: dari setelah laporan ke layar 2, dari layar 2 ke layar 1, dan di layar 1 keluar; pilihan Keluar setelah laporan langsung keluar. Ctrl-C saat analisa berjalan membatalkan analisa dan kembali ke layar 2. Untuk koneksi dari `.env` atau env, layar 2 menyediakan "Simpan koneksi ini". Terminal selalu dikembalikan seperti semula.

### Tambah koneksi dari `.env`

```sh
dbc add --env            # ./.env
dbc add --env path/ke/.env
dbc add --env path/ke/folder
```

`DATABASE_URL`-style (`postgres://`, `mysql://`, ...) dan kelompok variabel seperti `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` atau `PGHOST`/`PGUSER`/... dikenali; `${VAR}` diganti, awalan REDIS, MAIL, dan sejenisnya dilewati. Sebelum disimpan, `dbc` mencoba konek dan menyimpan versi server. Menu juga punya "+ Tambah koneksi" untuk tambah dari `.env` atau manual (`dbc add`).

### File koneksi (dibagi dengan `dbb`)

Koneksi disimpan di `~/.dbb/databases.json`, file yang sama dengan `dbb`. Lokasi bisa diganti dengan `DBB_CONFIG` (path file) atau `DBB_HOME` (folder). File berizin `600` dan berisi password, jadi jangan di-commit atau dibagikan; file dengan izin lebih longgar tetap dipakai tapi memunculkan peringatan. `dbc` hanya mengubah entri yang bersangkutan dan mempertahankan field lain milik `dbb`. Field opsional `ssl` (Postgres: nilai `sslmode` seperti `require`, `no-verify`, `verify-full`; MySQL: `true` atau `skip-verify`) hanya dipakai `dbc`; `dbb` mengabaikannya. File yang rusak tidak pernah ditulis.

### Subcommand

```sh
dbc list                       # daftar koneksi tersimpan (tanpa password)
dbc add                        # tambah manual
dbc add --env [FILE|DIR]       # tambah dari .env
dbc remove [nama] [--yes]      # hapus koneksi
dbc <nama> [--top n --watch detik --output file --no-mask]   # laporan koneksi tersimpan, tanpa menu
```

Koneksi bernama `add`, `list`, atau `remove` hanya bisa dipilih lewat menu.

## Pemakaian (connection string langsung)

`db-checkup` adalah nama lain untuk `dbc`; semua contoh di bawah berlaku untuk keduanya.

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
