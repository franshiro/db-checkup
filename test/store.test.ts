import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storePath, loadConnections, saveConnection, removeConnection, connectionUrl, StoreError, type SavedConnection } from '../src/store.js';
import { parseConnectionUrl } from '../src/connection.js';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'dbc-store-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const base = { type: 'postgres', host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' };
const conn = (name: string, o: Partial<SavedConnection> = {}): SavedConnection => ({ ...base, name, ...o } as SavedConnection);

test('storePath', () => {
  assert.equal(storePath({ DBB_CONFIG: '/a/b.json' }), '/a/b.json');
  assert.equal(storePath({ DBB_HOME: '/h' }), '/h/databases.json');
  assert.equal(storePath({}, '/home/u'), '/home/u/.dbb/databases.json');
});

test('saveConnection replaces in place, keeps foreign fields and other entries', async () => {
  const p = join(dir, 'one', 'databases.json');
  const a = { ...base, name: 'a', bulk: true, x: { y: 1 } };
  const b = { ...base, name: 'b', extra: [1] };
  await saveConnection(p, conn('seed')); // creates folder + file
  await writeFile(p, JSON.stringify([a, b]));
  await saveConnection(p, conn('a', { host: 'new' }));
  const raw = await readFile(p, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.includes('\n  {'));
  const out = JSON.parse(raw);
  assert.deepEqual(out.map((e: any) => e.name), ['a', 'b']);
  assert.equal(out[0].host, 'new');
  assert.equal(out[0].bulk, true);
  assert.deepEqual(out[0].x, { y: 1 });
  assert.deepEqual(out[1], b);
  assert.equal((await stat(p)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(dir, 'one'))).filter(f => f.includes('.tmp')), []);
  await saveConnection(p, conn('c'));
  assert.equal(JSON.parse(await readFile(p, 'utf8')).at(-1).name, 'c');
});

test('missing file loads empty; save creates file and folder', async () => {
  const p = join(dir, 'deep', 'er', 'databases.json');
  assert.deepEqual((await loadConnections(p)).connections, []);
  await saveConnection(p, conn('a'));
  assert.equal((await loadConnections(p)).connections.length, 1);
});

test('corrupt file: StoreError, untouched, message leaks nothing', async () => {
  const p = join(dir, 'bad.json');
  await writeFile(p, '{not json');
  for (const f of [() => loadConnections(p), () => saveConnection(p, conn('a'))]) {
    await assert.rejects(f, (e: Error) => e instanceof StoreError && !e.message.includes('not json'));
  }
  assert.equal(await readFile(p, 'utf8'), '{not json');
  await writeFile(p, '{"a":1}');
  await assert.rejects(loadConnections(p), StoreError);
});

test('invalid entries are hidden but preserved; defaults; duplicates', async () => {
  const p = join(dir, 'inv.json');
  const bad1 = { ...base, name: 'x', type: 'oracle' };
  const bad2 = { name: 'nohost', type: 'mysql', user: 'u', database: 'd' };
  const min = { name: 'm', type: 'mysql', host: 'h', user: 'u', database: 'd' };
  await writeFile(p, JSON.stringify([bad1, bad2, min, { ...min, host: 'dup' }]));
  const { connections } = await loadConnections(p);
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0], { ...min, port: 3306, password: '' });
  await saveConnection(p, conn('z'));
  const out = JSON.parse(await readFile(p, 'utf8'));
  assert.deepEqual(out.slice(0, 2), [bad1, bad2]);
  assert.deepEqual(out[2], min);
});

test('loose permissions warn once', async () => {
  const p = join(dir, 'perm.json');
  await writeFile(p, '[]');
  await chmod(p, 0o644);
  assert.equal((await loadConnections(p)).warnings.length, 1);
  await chmod(p, 0o600);
  assert.equal((await loadConnections(p)).warnings.length, 0);
});

test('removeConnection', async () => {
  const p = join(dir, 'rm.json');
  const keep = { ...base, name: 'k', bulk: 1 };
  await writeFile(p, JSON.stringify([{ ...base, name: 'r' }, keep]));
  assert.equal(await removeConnection(p, 'nope'), false);
  assert.equal(await removeConnection(p, 'r'), true);
  assert.deepEqual(JSON.parse(await readFile(p, 'utf8')), [keep]);
});

test('connectionUrl round-trips', () => {
  const my = conn('m', { type: 'mysql', user: 'a@b', password: 'p@ss#w/rd %x', database: 'd b', port: 3306 });
  const cfg = parseConnectionUrl(connectionUrl(my));
  assert.ok(cfg.dialect === 'mysql');
  assert.equal(cfg.mysql.user, 'a@b');
  assert.equal(cfg.mysql.password, 'p@ss#w/rd %x');
  assert.equal(cfg.mysql.database, 'd b');
  const pg = conn('p', { user: 'a@b', password: 'p@ss#w/rd %x', ssl: 'require' });
  const url = connectionUrl(pg);
  const u = new URL(url);
  assert.equal(decodeURIComponent(u.username), 'a@b');
  assert.equal(decodeURIComponent(u.password), 'p@ss#w/rd %x');
  assert.equal(decodeURIComponent(u.pathname.slice(1)), 'd');
  assert.ok(url.includes('sslmode=require'));
  assert.equal(parseConnectionUrl(url).dialect, 'postgres');
  assert.doesNotThrow(() => parseConnectionUrl(connectionUrl(conn('m', { type: 'mysql', ssl: 'skip-verify' }))));
});
