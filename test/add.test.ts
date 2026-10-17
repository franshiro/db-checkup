import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { addFromEnv, addManual, type AddDeps } from '../src/add.js';
import { main } from '../src/cli.js';
import { loadConnections, saveConnection } from '../src/store.js';
import type { Term } from '../src/tui.js';
import { fakeAdapter } from './helpers.js';

const ENV = `DB_CONNECTION=pgsql
DB_HOST=10.0.0.5
DB_PORT=5433
DB_DATABASE=mes_dev
DB_USERNAME=mes
DB_PASSWORD=pw-one
REPORT_DATABASE_URL=mysql://rep:s%40cret@db.local:3307/reports?ssl=true
PGHOST=pg.local
PGUSER=mes
PGDATABASE=analytics
APP_HOST=h
APP_DATABASE=d
APP_USER=u
`;
let dir: string, sp: string, out: string;
const mkDeps = (over: Partial<AddDeps> = {}): AddDeps => ({
  term: null, storePath: sp, createAdapter: async () => fakeAdapter(), out: { write: s => { out += s; } }, ...over,
});
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dbc-add-')); sp = join(dir, 'databases.json'); out = ''; await writeFile(join(dir, '.env'), ENV); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('addFromEnv non-interactive saves known types with version, skips null type with warning', async () => {
  const saved = await addFromEnv(mkDeps(), dir);
  assert.equal(saved.length, 3);
  const { connections } = await loadConnections(sp);
  assert.equal(connections.length, 3);
  assert.ok(connections.every(c => c.version === '16.0'));
  assert.match(out, /Peringatan/);
});

test('addFromEnv: failing connect with password in message is not saved nor printed', async () => {
  const d = mkDeps({ createAdapter: async (c) => { throw new Error('auth failed ' + (c.dialect === 'postgres' ? c.url : c.mysql.password)); } });
  assert.deepEqual(await addFromEnv(d, join(dir, '.env')), []);
  assert.deepEqual((await loadConnections(sp)).connections, []);
  assert.ok(!out.includes('pw-one') && !out.includes('s@cret'), out);
});

test('addFromEnv does not overwrite existing name non-interactively', async () => {
  await addFromEnv(mkDeps(), dir);
  const before = await readFile(sp, 'utf8');
  assert.deepEqual(await addFromEnv(mkDeps(), dir), []);
  assert.equal(await readFile(sp, 'utf8'), before);
});

function termMock() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const writes: string[] = [];
  const t: Term = { input, output: { write: s => writes.push(s) }, color: false };
  // feed one key per tick so each prompt resolves before the next key arrives
  const type = async (...keys: string[]) => { for (const k of keys) { await new Promise(r => setImmediate(r)); input.write(k); } };
  return { t, type, out: () => writes.join('') };
}

test('addManual with scripted keys saves entered fields; password never shown', async () => {
  const m = termMock();
  const p = addManual(mkDeps({ term: m.t }));
  await m.type('\x1b[B', '\r');                       // mysql
  await m.type(...'shop', '\r');                      // name
  await m.type('\r');                                 // host default
  await m.type('\r');                                 // port default
  await m.type('\r');                                 // user default
  await m.type(...'hunter2', '\r');                   // password
  await m.type(...'appdb', '\r');                     // database
  await m.type('\r');                                 // ssl empty
  const c = await p;
  assert.equal(c?.name, 'shop');
  const [s] = (await loadConnections(sp)).connections;
  assert.deepEqual([s.type, s.host, s.port, s.user, s.password, s.database, s.version], ['mysql', 'localhost', 3306, 'root', 'hunter2', 'appdb', '16.0']);
  assert.ok(!('ssl' in s));
  assert.ok(!m.out().includes('hunter2') && !out.includes('hunter2'));
});

const store = async () => {
  await saveConnection(sp, { name: 'prod', type: 'postgres', host: 'db.example', port: 5432, user: 'app', password: 'topsecret', database: 'shop', version: '16.0' });
};
function capture() {
  let o = '', e = '';
  return { stdout: { write: (s: string) => { o += s; }, isTTY: false }, stderr: { write: (s: string) => { e += s; }, isTTY: false }, out: () => o, err: () => e };
}

test('main list shows name and host, no password', async () => {
  await store();
  const io = capture();
  assert.equal(await main(['list'], {}, io, { createAdapter: async () => fakeAdapter(), storePath: sp }), 0);
  assert.match(io.out(), /prod/); assert.match(io.out(), /db\.example/);
  assert.ok(!io.out().includes('topsecret'));
});

test('main list empty hints dbc add', async () => {
  const io = capture();
  await main(['list'], {}, io, { createAdapter: async () => fakeAdapter(), storePath: sp });
  assert.match(io.out(), /dbc add/); assert.ok(io.out().includes(sp));
});

test('main <name> analyzes the saved connection; unknown name -> 2', async () => {
  await store();
  let seen: any;
  const d = { createAdapter: async (c: any) => { seen = c; return fakeAdapter(); }, storePath: sp };
  const io = capture();
  assert.equal(await main(['prod'], {}, io, d), 0);
  assert.match(io.out(), /db\.example/); assert.ok(!io.out().includes('topsecret'));
  assert.equal(seen.dialect, 'postgres'); assert.match(seen.url, /^postgresql:\/\/app:topsecret@db\.example:5432\/shop/);
  const io2 = capture();
  assert.equal(await main(['nope'], {}, io2, d), 2); assert.match(io2.err(), /nope/);
});

test('main remove needs --yes without a TTY', async () => {
  await store();
  const d = { createAdapter: async () => fakeAdapter(), storePath: sp };
  const io = capture();
  assert.equal(await main(['remove', 'prod'], {}, io, d), 2);
  assert.match(io.err(), /--yes/);
  assert.equal((await loadConnections(sp)).connections.length, 1);
  assert.equal(await main(['remove', 'prod', '--yes'], {}, capture(), d), 0);
  assert.equal((await loadConnections(sp)).connections.length, 0);
});

test('main add --env imports from a folder', async () => {
  await mkdir(join(dir, 'x'), { recursive: true });
  const io = capture();
  assert.equal(await main(['add', '--env', dir], {}, io, { createAdapter: async () => fakeAdapter(), storePath: sp }), 0);
  assert.equal((await loadConnections(sp)).connections.length, 3);
});

test('loose store permissions warn once on stderr for list and <name>', async () => {
  await store();
  await chmod(sp, 0o644);
  const d = { createAdapter: async () => fakeAdapter(), storePath: sp };
  for (const argv of [['list'], ['prod']]) {
    const io = capture();
    await main(argv, {}, io, d);
    assert.equal(io.err().split('chmod 600').length - 1, 1, io.err());
  }
});
