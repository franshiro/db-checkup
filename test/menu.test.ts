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
import { fakeAdapter } from './helpers.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const tick = () => new Promise(r => setImmediate(r));
const DOWN = '\x1b[B';
const exists = (p: string) => access(p).then(() => true, () => false);

let dir: string, sp: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dbc-menu-')); sp = join(dir, 'store', 'databases.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const prod: SavedConnection = { name: 'prod', type: 'postgres', host: 'db.prod', port: 5432, user: 'app', password: 'pw-secret', database: 'shop' };

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
  await h.keys(...Array(6).fill(DOWN), '\r', 'q');
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
  await h.keys(...Array(6).fill(DOWN), '\r', '\r');
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
  await h.keys('\r');
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
  await h.keys(...Array(6).fill(DOWN), '\r', 'q');
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
  await h.keys(...Array(6).fill(DOWN), '\r', 'q');
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
