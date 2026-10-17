# Desain: `dbc`, menu interaktif untuk db-checkup

Tanggal: 2026-10-17. Melanjutkan [desain db-checkup](2026-10-17-db-checkup-design.md); semua jaminan di sana (hanya membaca, masking, saran index tidak pernah dijalankan) tetap berlaku.

## Maksud dan alasan

Sekarang setiap analisa butuh connection string lengkap di command line. Itu merepotkan di server: harus ingat host, user, password, dan nama database, lalu mengetiknya setiap kali. Pengguna sudah punya `dbb` (repo `franshiro/db-backup`) yang menyimpan daftar koneksi dan punya menu panah seperti `mo` (tw93/mole). `dbc` membawa pengalaman yang sama ke db-checkup: ketik `dbc`, pilih database dengan panah, pilih jenis analisa, simpan laporan ke Markdown, kembali ke menu.

Sukses berarti: di server, `cd` ke folder project, ketik `dbc`, dan dalam beberapa tombol sudah ada laporan `.md` untuk dibagikan ke tim, tanpa mengetik connection string.

## Tujuan

- Perintah pendek `dbc`. Tanpa argumen di terminal interaktif: membuka menu.
- Layar 1: pilih database dari daftar koneksi tersimpan.
- Layar 2: pilih jenis analisa untuk database itu.
- Setelah laporan tampil: simpan ke `.md`, lalu kembali ke menu.
- Tambah koneksi dari `.env` di folder tempat `dbc` dibuka, dengan aturan yang sama seperti `dbb add --env`.
- Daftar koneksi memakai file yang sama dengan `dbb`.

## Bukan tujuan

- Fitur `dbb` lain (backup, restore, bulk, export/import). Yang dipakai bersama hanya daftar koneksi.
- Dashboard live yang terus refresh.
- Mengubah koneksi yang sudah ada di tempat (edit). Menambah ulang dengan nama sama menimpa, seperti `dbb`. *(Keputusan Claude.)*
- Dependency baru untuk TUI. Menu dibangun dengan `node:readline` (keypress + raw mode). *(Keputusan Claude.)*

## Anti-tujuan (gagal walau "jalan")

- Merusak `~/.dbb/databases.json`: menghapus field yang tidak dikenal `dbc` (`bulk`, `version`, atau field lain dari `dbb`), mengubah urutan entri, atau meninggalkan file setengah tertulis.
- File koneksi berakhir dengan izin selain `600`.
- Password muncul di layar, di laporan, atau di pesan error.
- Script dan cron yang memakai `db-checkup <url> --top --watch --output` rusak.
- Terminal tertinggal dalam raw mode atau kursor tersembunyi setelah Ctrl-C, error, atau keluar.

## Perintah

| Perintah | Perilaku |
|---|---|
| `dbc` (stdin dan stdout TTY) | Buka menu interaktif, juga kalau `DATABASE_URL` diset (lihat layar 1). Berlaku sama untuk nama `db-checkup`. *(Keputusan Claude.)* |
| `dbc` (bukan TTY) | Perilaku lama: pakai `DATABASE_URL`, kalau tidak ada exit 2 dengan pesan penggunaan. |
| `dbc <url> [opsi]` | Perilaku lama `db-checkup`, tidak berubah. Argumen dianggap URL kalau mengandung `://`. |
| `dbc <nama> [opsi]` | Laporan lengkap untuk koneksi tersimpan bernama `<nama>`, tanpa menu. Opsi `--top`, `--watch`, `--output`, `--no-mask` berlaku. Nama tidak ditemukan: exit 2. |
| `dbc add` | Tambah manual (tanya jenis, host, port, user, password tanpa echo, database). |
| `dbc add --env [FILE\|DIR]` | Tambah dari `.env` (default `./.env`). |
| `dbc list` | Tampilkan koneksi tersimpan (tanpa password). |
| `dbc remove [nama]` | Hapus koneksi, dengan konfirmasi. |

Koneksi tersimpan bernama `add`, `list`, atau `remove` hanya bisa dipilih lewat menu.

`db-checkup` tetap ada sebagai nama perintah kedua (alias) untuk program yang sama. `--help` dan `--version` tetap ada.

## Layar 1: pilih database

- Header seperti mockup gaya A: logo ASCII besar, baris "analisa database · hanya membaca · v<versi>".
- Daftar koneksi tersimpan: nama, jenis, host. Baris terpilih disorot dengan `➤`.
- Kalau folder saat ini punya `.env` dengan koneksi yang belum tersimpan (host, port, user, database berbeda dari semua entri), koneksi itu muncul di atas daftar dengan tanda "dari .env". Memilihnya langsung menganalisa tanpa menyimpan; ada pilihan untuk menyimpannya.
- Kalau `DATABASE_URL` diset di environment, koneksi itu juga muncul di atas daftar dengan tanda "dari env DATABASE_URL", dengan perilaku sama seperti baris "dari .env".
- Baris dari `.env` yang jenisnya tidak bisa ditebak tetap ditampilkan; jenisnya ditanya saat baris itu dipakai atau disimpan. Tombol `d` tidak berlaku untuk baris "dari .env" dan "dari env".
- Di bawah daftar: "+ Tambah koneksi" (submenu: dari `.env`, manual) dan "Pakai connection string sekali" (tidak disimpan).
- Tombol: ↑↓ atau j/k gerak, Enter buka, `d` hapus (dengan konfirmasi), q atau Esc keluar.
- Daftar kosong dan tidak ada `.env`: tampilkan petunjuk menambah koneksi, dengan "+ Tambah koneksi" terpilih.

## Layar 2: pilih jenis analisa

- Saat database dipilih: konek sekali (sesi read-only yang sama seperti sekarang), tampilkan `dbc › <nama> (<flavor> <versi>)` di header. Gagal konek: tampilkan pesan error yang sudah disamarkan, kembali ke layar 1.
- Pilihan dan bagian laporan yang dihasilkan *(pemetaan: keputusan Claude)*:

| Pilihan | Bagian laporan |
|---|---|
| Laporan lengkap | Semua bagian, sama dengan mode CLI. |
| Query paling lambat | Ringkasan + Query paling lambat (akumulasi). |
| Saran index | Ringkasan + Saran index (tetap butuh statistik query sebagai sumber). |
| Kondisi sekarang | Ringkasan + Query yang sedang jalan lama + Query yang saling mengunci. |
| Pantau perubahan | Tanya jeda detik (default 60), lalu Ringkasan + Query terberat saat ini + Query paling lambat + Saran index. |
| Kesehatan index | Ringkasan + Tabel yang sering di-scan penuh + Foreign key tanpa index + Index yang tidak pernah dipakai. |
| ← Kembali | Tutup koneksi, kembali ke layar 1. |

- Masking literal selalu aktif di menu (tidak ada padanan `--no-mask`).
- Ctrl-C saat analisa atau hitung mundur Pantau perubahan berjalan: batalkan, tampilkan "Dibatalkan", kembali ke layar 2, seperti `dbb` yang kembali ke menu. Hitung mundur berhenti seketika; query yang sedang jalan dibiarkan selesai (dibatasi `statement_timeout` / `max_execution_time` 5 detik) lalu langkah berikutnya tidak dijalankan. Ctrl-C di layar menu sama dengan q. *(Keputusan Claude.)*
- Bagian yang tidak diminta tidak dijalankan sama sekali ke database (bukan hanya disembunyikan).
- Koneksi ditutup saat kembali ke layar 1 atau keluar.

## Setelah laporan tampil

- Laporan dicetak ke terminal seperti sekarang; yang panjang di-scroll lewat terminal, tanpa pager.
- Di bawahnya pilihan panah: **Simpan ke .md** (pilihan pertama), **Jalankan lagi**, **Kembali ke menu**, **Keluar**.
- Simpan: tanya nama file, default `./<nama-koneksi>-<YYYYMMDD-HHmm>.md` di folder saat ini. File sudah ada: tanya timpa. Karakter yang tidak aman untuk nama file (mis. `/`) di nama koneksi diganti `-`. Setelah tersimpan, tampilkan path-nya, lalu kembali ke layar 2 untuk koneksi yang sama.
- Kembali ke menu: layar 2 untuk koneksi yang sama.

## Daftar koneksi (dipakai bersama dengan `dbb`)

- File: `$DBB_CONFIG`, kalau tidak ada `$DBB_HOME/databases.json`, kalau tidak ada `~/.dbb/databases.json`. Sama seperti `dbb`.
- Format: array JSON, tiap entri `{name, type, host, port, user, password, database}` plus field opsional. `type` hanya `postgres` atau `mysql` (MariaDB disimpan sebagai `mysql`, seperti `dbb`).
- Tulis: baca file terbaru tepat sebelum menulis, ubah hanya entri yang bersangkutan, simpan semua field lain apa adanya, urutan entri tetap. Format sama dengan `dbb`: indent 2 spasi dan newline di akhir. Tulis ke file sementara di folder yang sama lalu rename, izin `600`.
- Baca: file dengan izin lebih longgar dari `600` tetap dipakai, tapi muncul peringatan sekali.
- File rusak (bukan JSON valid, atau bukan array): tampilkan error tanpa isi file, jangan pernah menulis ke file itu. Menu tetap bisa dipakai untuk baris "dari .env", "dari env", dan connection string sekali pakai. *(Keputusan Claude.)*
- Entri tidak lengkap (tanpa `name`, `host`, `user`, atau `database`) atau `type` tidak dikenal: tidak ditampilkan, tapi tetap disimpan apa adanya saat file ditulis. `port` dan `password` yang kosong diisi default saat dipakai (5432/3306, password kosong), seperti `dbb`, tanpa ditulis balik. Nama ganda: entri pertama yang dipakai. *(Keputusan Claude.)*
- Output JSON tidak harus identik byte demi byte dengan `json.dumps` milik `dbb` (mis. escape `\uXXXX`); cukup isi datanya sama.
- SSL: `dbb` tidak menyimpan setelan SSL, padahal database cloud sering mewajibkannya. `dbc` menambah field opsional `ssl` berisi nilai query string yang sudah diterima `parseConnectionUrl` (Postgres: nilai `sslmode`, mis. `require`, `no-verify`, `verify-full`; MySQL: `true` atau `skip-verify`). Diisi dari URL `.env` yang memuat `sslmode`/`ssl`, atau ditanya saat tambah manual (default kosong). `PGSSLMODE` di environment tetap dihormati driver Postgres. `dbb` mengabaikan field ini. *(Keputusan Claude.)*
- Entri dari file diubah ke connection string lalu lewat `parseConnectionUrl` yang sudah ada, dengan user, password, dan database di-percent-encode. Semua jalur redaksi password yang ada tetap berlaku.

## Tambah dari `.env`

Ikuti `dbb.py` (`read_env`, `env_candidates`, `add_from_env`) sebagai acuan perilaku:

- Baris kosong dan baris diawali `#` diabaikan; `export KEY=...` dikenali; nilai dalam kutip diambil apa adanya (termasuk `#`); komentar inline setelah spasi dibuang; `${VAR}` diganti dengan nilai key lain di file yang sama.
- Kandidat: nilai berupa URL `postgres://`, `postgresql://`, `mysql://`, `mariadb://` (juga skema dengan `+driver`), dan kelompok variabel `PREFIX_HOST/PORT/USER/USERNAME/PASSWORD/PASS/NAME/DATABASE/DB/DBNAME/CONNECTION/TYPE/DRIVER/...` termasuk awalan `PG` (`PGHOST`, `PGUSER`, ...). Awalan yang mengandung REDIS, MONGO, CACHE, QUEUE, MAIL, SMTP, ELASTIC, RABBIT, AMQP, KAFKA, AWS, S3 dilewati. Kelompok butuh database dan host atau user.
- Jenis ditebak dari `CONNECTION/TYPE/...`, dari nama awalan, lalu dari port 5432/3306; kalau tetap tidak tahu, tanya.
- Duplikat (host, port, user, database sama) digabung.
- Nama default: `<nama-folder>[-<varian env>][-<awalan>]`, mis. `.env.production` di folder `shop` dengan awalan `REPORT_DATABASE` menjadi `shop-production-report`. Bisa diubah sebelum disimpan.
- Lebih dari satu kandidat: pilih satu atau "Semuanya".
- Sebelum disimpan: coba konek dan ambil versi server (disimpan di `version`, seperti `dbb`). Gagal konek: tanya "tetap simpan?". Nama sudah ada: tanya timpa.
- Uji perilaku memakai kasus di `test_env.py` milik `dbb` (Laravel style, `#` inline dalam kutip, `${VAR}`, URL MySQL dengan `%40`, grup `PG*`, REDIS/MAIL dilewati).

## Teks dan tampilan

- Semua teks dalam bahasa Indonesia, sama seperti laporan sekarang.
- Warna mengikuti aturan yang ada: mati kalau bukan TTY atau `NO_COLOR` diset.
- Lebar terminal sempit: label dipotong, menu tetap bisa dipakai.
- Daftar panjang (lebih dari tinggi layar) bisa di-scroll di dalam menu.

## Install

- `package.json` `bin` mendaftarkan `dbc` dan `db-checkup`.
- `install.sh` mencetak `dbc` di pesan akhir; `--uninstall` menghapus keduanya (lewat `npm uninstall -g`).
- README: bagian pemakaian `dbc` di atas, cara CLI lama tetap terdokumentasi.

## Diserahkan ke builder

- Struktur file dan cara memecah `analyze()` per bagian, selama perilaku "Laporan lengkap" dan mode CLI identik dengan sekarang.
- Bentuk komponen menu dan cara mengujinya (mis. input tombol yang disuntikkan).
- Bentuk persis logo ASCII.
