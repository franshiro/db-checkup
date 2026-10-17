import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runMenu, type MenuDeps } from '../src/menu.js';
import { loadConnections, saveConnection, type SavedConnection } from '../src/store.js';
import { defaultName } from '../src/dotenv.js';
import type { Term } from '../src/tui.js';
import type { DbAdapter } from '../src/types.js';
import { fakeAdapter, pgFacts } from './helpers.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const tick = () => new Promise(r => setImmediate(r));
const DOWN = '\x1b[B';
const exists = (p: string) => access(p).then(() => true, () => false);

let dir: string, sp: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dbc-menu-')); sp = join(dir, 'store', 'databases.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const bare: SavedConnection = { name: 'prod', type: 'postgres', host: 'db.prod', port: 5432, user: 'app', password: 'pw-secret', database: 'shop' };
const prod: SavedConnection = { ...bare, dedicated: true, ram_mb: 8192 };   // server info known: no prompts

function harness(over: Partial<MenuDeps> = {}, adapter: Partial<DbAdapter> = {}) {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(on: boolean) { raw.push(on); } });
  const writes: string[] = [];
  const term: Term = { input, output: { write: (s: string) => writes.push(s) }, color: false };
  const h = {
    raw, creates: 0, closes: 0, interrupt: undefined as (() => void) | undefined,
    out: () => strip(writes.join('')),
    // One key at a time, only once a prompt is listening (keys in one chunk after a prompt resolves are dropped).
    async keys(...ks: string[]) {
      for (const k of ks) {
        const end = Date.now() + 5000;
        while (input.listenerCount('keypress') === 0) { if (Date.now() > end) throw new Error('no prompt for ' + JSON.stringify(k) + '\n' + h.out()); await tick(); }
        input.write(k);
        await tick();
      }
    },
    async until(text: string) {
      const end = Date.now() + 5000;
      while (!h.out().includes(text)) { if (Date.now() > end) throw new Error('missing ' + text + '\n' + h.out()); await tick(); }
    },
  };
  const d: MenuDeps = {
    term, env: {}, cwd: dir, storePath: sp, version: '9.9.9',
    createAdapter: async () => { h.creates++; return fakeAdapter({ close: async () => { h.closes++; }, ...adapter }); },
    now: () => new Date(2026, 9, 17, 9, 5),
    onInterrupt: cb => { h.interrupt = cb; return () => { h.interrupt = undefined; }; },
    ...over,
  };
  return { h, run: () => runMenu(d) };
}

test('save full report to default .md, back, quit; connection closed once', async () => {
  await saveConnection(sp, prod);
  const { h, run } = harness();
  const p = run();
  await h.keys('\r', '\r', '\r', '\r');
  await h.until('Tersimpan');
  const md = await readFile(join(dir, 'prod-20261017-0905.md'), 'utf8');
  assert.ok(md.startsWith('# Laporan db-checkup'));
  await h.keys(...Array(8).fill(DOWN), '\r', 'q');
  assert.equal(await p, 0);
  assert.equal(h.closes, 1);
  assert.ok(h.out().includes('dbc › prod (postgres 16.0)'));
  assert.ok(!h.out().includes('pw-secret'));
});

test('unsaved .env connection is listed first and analyzing it does not write the store', async () => {
  await writeFile(join(dir, '.env'), 'DATABASE_URL=postgres://u:p@h/shop\n');
  const { h, run } = harness();
  const p = run();
  await h.until('➤');
  const first = h.out().split('\n').find(l => l.includes('➤'))!;
  assert.match(first, /dari \.env/);
  await h.keys('\r', 'q', 'q');
  assert.equal(await p, 0);
  assert.equal(h.creates, 1);
  assert.equal(await exists(sp), false);
});

test('.env row: "Simpan koneksi ini" saves under defaultName', async () => {
  await writeFile(join(dir, '.env'), 'DATABASE_URL=postgres://u:p@h/shop\n');
  const { h, run } = harness();
  const p = run();
  await h.keys('\r');
  await h.until('Simpan koneksi ini');
  await h.keys(...Array(7).fill(DOWN), '\r', '\r');
  await h.until('Tersimpan');
  await h.keys('q', 'q');
  assert.equal(await p, 0);
  const [c] = (await loadConnections(sp)).connections;
  assert.deepEqual([c.name, c.host, c.user, c.password, c.database], [defaultName(join(dir, '.env'), 'DATABASE'), 'h', 'u', 'p', 'shop']);
});

test('env DATABASE_URL is listed', async () => {
  const { h, run } = harness({ env: { DATABASE_URL: 'postgres://u:p@envhost/db' } });
  const p = run();
  await h.until('dari env DATABASE_URL');
  await h.keys('q');
  assert.equal(await p, 0);
});

test('one-off connection string analyzes without touching the store; password hidden', async () => {
  const { h, run } = harness();
  const p = run();
  await h.keys(DOWN, '\r', ...'postgres://x:sekret9@h/db', '\r');
  await h.until('dbc ›');
  await h.keys('\r', '\r', '8', 'G', '\r');
  await h.until('Ringkasan');
  await h.keys(DOWN, DOWN, DOWN, '\r'); // Keluar
  assert.equal(await p, 0);
  assert.equal(h.creates, 1);
  assert.equal(h.closes, 1);
  assert.equal(await exists(sp), false);
  assert.ok(!h.out().includes('sekret9'));
});

test('"Jalankan lagi" reruns without reconnecting', async () => {
  await saveConnection(sp, prod);
  let runs = 0;
  const { h, run } = harness({}, { statements: async () => { runs++; return []; } });
  const p = run();
  await h.keys('\r', '\r', DOWN, '\r', DOWN, DOWN, DOWN, '\r');
  assert.equal(await p, 0);
  assert.equal(runs, 2);
  assert.equal(h.creates, 1);
  assert.equal(h.closes, 1);
});

test('no store and no .env: hint shown, Enter opens add submenu', async () => {
  const { h, run } = harness();
  const p = run();
  await h.until('Belum ada koneksi');
  await h.keys('\r');
  await h.until('dari .env');
  await h.keys('q', 'q');
  assert.equal(await p, 0);
});

test('corrupt store: error shown, menu still works, file untouched', async () => {
  await saveConnection(sp, prod);
  await writeFile(sp, '{nope');
  const { h, run } = harness();
  const p = run();
  await h.until('rusak');
  await h.keys('q');
  assert.equal(await p, 0);
  assert.equal(await readFile(sp, 'utf8'), '{nope');
});

test('connect failure is redacted and returns to screen 1', async () => {
  await saveConnection(sp, prod);
  const { h, run } = harness({ createAdapter: async c => { throw new Error('auth failed ' + (c.dialect === 'postgres' ? c.url : '')); } });
  const p = run();
  await h.keys('\r');
  await h.until('Gagal konek');
  await h.keys('q');
  assert.equal(await p, 0);
  assert.ok(!h.out().includes('pw-secret'));
  assert.equal(h.out().split('Pilih database').length - 1, 2);
});

test('Ctrl-C during watch cancels and returns to screen 2', async () => {
  await saveConnection(sp, prod);
  const { h, run } = harness();
  const p = run();
  await h.keys('\r', ...Array(4).fill(DOWN), '\r', '3', '\r');
  await h.until('Menunggu');
  h.interrupt!();
  await h.until('Dibatalkan');
  await h.keys(...Array(8).fill(DOWN), '\r', 'q');
  assert.equal(await p, 0);
  assert.equal(h.interrupt, undefined);
  assert.equal(h.closes, 1);
});

test('info() failing after connect still closes and restores the terminal', async () => {
  await saveConnection(sp, prod);
  const { h, run } = harness({}, { info: async () => { throw new Error('boom'); } });
  const p = run();
  await h.keys('\r');
  await h.until('boom');
  await h.keys('q');
  assert.equal(await p, 0);
  assert.equal(h.closes, 1);
  assert.equal(h.raw.at(-1), false);
});

test('unsafe connection name characters become - in the default file name', async () => {
  await saveConnection(sp, { ...prod, name: 'a/b' });
  const { h, run } = harness();
  const p = run();
  await h.keys('\r', '\r', '\r', '\r');
  await h.until('Tersimpan');
  assert.ok(await exists(join(dir, 'a-b-20261017-0905.md')));
  await h.keys(...Array(8).fill(DOWN), '\r', 'q');
  assert.equal(await p, 0);
});

test('d removes a saved connection after confirm; d on a .env row does nothing', async () => {
  await saveConnection(sp, prod);
  await writeFile(join(dir, '.env'), 'DATABASE_URL=postgres://u:p@h/shop\n');
  const { h, run } = harness();
  const p = run();
  await h.keys('d', DOWN, 'd', 'y', 'q');
  assert.equal(await p, 0);
  assert.deepEqual((await loadConnections(sp)).connections, []);
  assert.equal(h.out().split('Hapus "').length - 1, 1);
  assert.ok(h.out().includes('d hapus'));
});

test('store with non-string fields: screen 1 renders and q exits 0; list exits 0', async () => {
  await saveConnection(sp, prod);
  await writeFile(sp, JSON.stringify([{ ...prod, name: 123 }, { ...prod, name: 'x', port: 'abc' }, prod]));
  const { h, run } = harness();
  const p = run();
  await h.until('Pilih database');
  await h.keys('q');
  assert.equal(await p, 0);
  assert.ok(!h.out().includes('Error'));
  const { main } = await import('../src/cli.js');
  const so: string[] = [];
  const w = { write: (s: string) => { so.push(s); return true; } } as any;
  const io = { stdout: w, stderr: w };
  assert.equal(await main(['list'], {}, io, { createAdapter: async () => fakeAdapter(), storePath: sp }), 0);
});

test('env DATABASE_URL is analyzed as given, keeping query params', async () => {
  const url = 'postgres://u:p@envhost/db?sslmode=require&sslrootcert=/x/ca.pem';
  let seen = '';
  const { h, run } = harness({ env: { DATABASE_URL: url }, createAdapter: async c => { seen = (c as any).url; return fakeAdapter(); } });
  const p = run();
  await h.keys('\r');
  await h.until('dbc ›');
  assert.ok(seen.includes('sslrootcert=/x/ca.pem'));
  await h.keys('q', 'q');
  assert.equal(await p, 0);
});

test('report path with ~ expands to the home directory', async () => {
  await saveConnection(sp, prod);
  const oldHome = process.env.HOME; process.env.HOME = dir; // keep the test inside its temp dir
  const { homedir } = await import('node:os');
  const name = `dbc-tilde-${process.pid}.md`;
  const { h, run } = harness();
  const p = run();
  try {
    await h.keys('\r', '\r', '\r');
    await h.keys(...Array(40).fill('\x7f'), ...('~/' + name), '\r');
    await h.until('Tersimpan');
    assert.ok(h.out().includes(join(homedir(), name)));
  } finally { process.env.HOME = oldHome; }
  await h.keys('q', 'q');
  await p;
});

const CONFIG = Array(6).fill(DOWN);   // screen 2 -> "Konfigurasi server"
const facts = { serverConfig: async () => pgFacts() as any };

test('Konfigurasi server asks once for a saved connection and stores the answers', async () => {
  await saveConnection(sp, bare);
  const { h, run } = harness({}, facts);
  const p = run();
  await h.keys('\r', ...CONFIG, '\r');
  await h.until('Server ini khusus database?');
  await h.keys(DOWN, '\r', '8', 'G', '\r');
  await h.until('Selanjutnya');
  assert.ok(h.out().includes('Konfigurasi server'));
  assert.ok(h.out().includes('Jatah RAM: 4GB'));
  assert.deepEqual((await loadConnections(sp)).connections, [{ ...bare, dedicated: false, ram_mb: 8192 }]);
  const asked = h.out().split('khusus database?').length;
  await h.keys(DOWN, DOWN, '\r', 'q');            // Kembali ke menu, back to screen 1
  await h.keys('\r', ...CONFIG, '\r');            // next session: no questions
  await h.keys(DOWN, DOWN, DOWN, '\r');           // Selanjutnya -> Keluar
  assert.equal(await p, 0);
  assert.equal(h.out().split('khusus database?').length, asked);
  assert.equal(h.out().split('Jatah RAM: 4GB').length - 1, 2);
});

test('local host: RAM prompt defaults to the RAM read from this machine', async () => {
  await saveConnection(sp, { ...bare, host: 'localhost' });
  const { h, run } = harness({ memory: async () => ({ totalMb: 16384 }) }, facts);
  const p = run();
  await h.keys('\r', ...CONFIG, '\r', '\r');
  await h.until('16G terbaca dari mesin ini');
  assert.ok(h.out().includes('[16G]'));
  await h.keys('\r');
  await h.until('Selanjutnya');
  await h.keys(DOWN, DOWN, DOWN, '\r');
  assert.equal(await p, 0);
  assert.equal((await loadConnections(sp)).connections[0].ram_mb, 16384);
});

test('.env row: server questions asked, store untouched', async () => {
  await writeFile(join(dir, '.env'), 'DATABASE_URL=postgres://u:p@h/shop\n');
  const { h, run } = harness({}, facts);
  const p = run();
  await h.keys('\r', ...CONFIG, '\r');
  await h.until('khusus database?');
  await h.keys('\r', '8', 'G', '\r');
  await h.until('Selanjutnya');
  assert.ok(h.out().includes('Jatah RAM: 8GB'));
  await h.keys(DOWN, DOWN, DOWN, '\r');
  assert.equal(await p, 0);
  assert.equal(await exists(sp), false);
});

test('invalid RAM size is rejected and asked again', async () => {
  await saveConnection(sp, bare);
  const { h, run } = harness({}, facts);
  const p = run();
  await h.keys('\r', ...CONFIG, '\r', '\r', 'x', '\r');
  await h.until('Ukuran RAM tidak valid (contoh: 8G, 512M)');
  await h.keys('2', 'G', '\r');
  await h.until('Jatah RAM: 2GB');
  await h.keys(DOWN, DOWN, DOWN, '\r');
  assert.equal(await p, 0);
});

test('"Ubah info server" asks even when info exists and saves the new answers', async () => {
  await saveConnection(sp, prod);
  const { h, run } = harness();
  const p = run();
  await h.keys('\r', ...Array(7).fill(DOWN), '\r');
  await h.until('khusus database?');
  await h.keys(DOWN, '\r', '4', 'G', '\r');
  await h.until('Info server tersimpan');
  await h.keys('q', 'q');
  assert.equal(await p, 0);
  assert.deepEqual((await loadConnections(sp)).connections, [{ ...bare, dedicated: false, ram_mb: 4096 }]);
});

test('Esc on the server question returns to screen 2 without analyzing', async () => {
  await saveConnection(sp, bare);
  let calls = 0;
  const { h, run } = harness({}, { serverConfig: async () => { calls++; return pgFacts() as any; } });
  const p = run();
  await h.keys('\r', ...CONFIG, '\r');
  await h.until('khusus database?');
  const screens = () => h.out().split('dbc › prod').length;
  const before = screens();
  await h.keys('\x1b');
  const end = Date.now() + 5000;
  while (screens() === before && Date.now() < end) await tick();   // screen 2 drawn again
  assert.equal(screens(), before + 1);
  await h.keys('q', 'q');
  assert.equal(await p, 0);
  assert.equal(calls, 0);
  assert.deepEqual((await loadConnections(sp)).connections, [bare]);
});

// Settings never runs a real command: `run` is a recorder.
function settingsFake() {
  const calls: string[] = [];
  return { calls, settings: { root: '/opt/dbc-test', run: async (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return { code: 0, out: '' }; } } };
}

test('Settings → Info shows version, install folder, connection file; back and quit', async () => {
  const f = settingsFake();
  const { h, run } = harness({ settings: f.settings });
  const done = run();
  await h.keys(DOWN, DOWN, '\r');          // ⚙ Settings (empty list: + Tambah, sekali, Settings)
  await h.until('Settings');
  await h.keys(DOWN, DOWN, '\r');          // Info
  await h.until('/opt/dbc-test');
  await h.keys('q', 'q');
  assert.equal(await done, 0);
  assert.ok(h.out().includes('9.9.9') && h.out().includes(sp));
  assert.deepEqual(f.calls, []);
  assert.match(h.out(), /q kembali/);
});

test('Settings → Uninstall asks first; "n" runs nothing, "y" runs the uninstaller and exits', async () => {
  const f = settingsFake();
  const { h, run } = harness({ settings: f.settings });
  const done = run();
  await h.keys(DOWN, DOWN, '\r', DOWN, '\r', 'n');
  await h.until('tidak');
  assert.deepEqual(f.calls, []);
  await h.keys(DOWN, '\r', 'y');
  assert.equal(await done, 0);
  assert.deepEqual(f.calls, ['bash -s -- --uninstall']);
});

test('Settings → Update without install.sh refuses and runs nothing', async () => {
  const f = settingsFake();
  const { h, run } = harness({ settings: f.settings });
  const done = run();
  await h.keys(DOWN, DOWN, '\r', '\r');    // Update (no install.sh in /opt/dbc-test → refuses, runs nothing)
  await h.until('install.sh');
  await h.keys('q', 'q');
  assert.equal(await done, 0);
  assert.deepEqual(f.calls, []);
});
