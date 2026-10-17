#!/usr/bin/env bash
# Install, update or uninstall db-checkup.
# Run from a clone (./install.sh [--uninstall]), or remotely:
#   curl -fsSL https://raw.githubusercontent.com/franshiro/db-checkup/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/franshiro/db-checkup/main/install.sh | bash -s -- --uninstall
set -euo pipefail

REPO=${DB_CHECKUP_REPO:-https://github.com/franshiro/db-checkup.git}
DIR=${DB_CHECKUP_DIR:-$HOME/.db-checkup}

fail() { echo "Gagal: $*" >&2; exit 1; }

SELF_DIR=
[ -n "${BASH_SOURCE[0]:-}" ] && SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ "${1:-}" = "--uninstall" ]; then
  command -v npm >/dev/null || fail "npm tidak ditemukan."
  echo "Menghapus perintah dbc dan db-checkup ..."
  npm uninstall -g db-checkup || fail "npm uninstall -g gagal. Kalau karena izin (EACCES), jalankan ulang dengan sudo."
  # Only delete the folder this script clones into, never the clone it was run from.
  if [ "$DIR" != "$SELF_DIR" ] && [ -d "$DIR/.git" ] && grep -qs '"name": "db-checkup"' "$DIR/package.json"; then
    echo "Menghapus $DIR ..."
    rm -rf "$DIR"
  fi
  echo "Selesai: dbc dan db-checkup sudah dihapus."
  exit 0
fi
[ $# -eq 0 ] || fail "opsi tidak dikenal: $1 (yang ada hanya --uninstall)"

command -v node >/dev/null || fail "Node.js belum terpasang. Butuh Node 20.12 atau lebih baru."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' \
  || fail "Node $(node -v) terlalu lama. Butuh Node 20.12 atau lebih baru."

# Inside a clone: install that clone. Otherwise clone to $DIR, or update it.
if [ -n "$SELF_DIR" ] && grep -qs '"name": "db-checkup"' "$SELF_DIR/package.json"; then
  DIR=$SELF_DIR
else
  command -v git >/dev/null || fail "git belum terpasang."
  if [ -d "$DIR/.git" ]; then
    echo "Memperbarui $DIR ..."
    git -C "$DIR" pull --ff-only
  else
    echo "Mengunduh ke $DIR ..."
    git clone --depth 1 "$REPO" "$DIR"
  fi
fi

cd "$DIR"
echo "Install dependency dan build ..."
npm install --no-audit --no-fund
npm run build
echo "Install perintah dbc dan db-checkup secara global ..."
npm install -g . || fail "npm install -g gagal. Kalau karena izin (EACCES), jalankan ulang dengan sudo atau atur npm prefix ke folder milik user."

command -v dbc >/dev/null || fail "dbc terpasang, tapi tidak ada di PATH. Tambahkan $(npm prefix -g)/bin ke PATH."
echo "Selesai: dbc $(dbc --version) di $(command -v dbc). Ketik dbc untuk membuka menu (db-checkup juga tersedia)."
