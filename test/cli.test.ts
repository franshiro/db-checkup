import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, redact } from '../src/cli.js';
import { fakeAdapter } from './helpers.js';

const deps = { createAdapter: async () => fakeAdapter({}) };
function capture() {
  let o = '', e = '';
  return {
    stdout: { write: (s: string) => { o += s; }, isTTY: false },
    stderr: { write: (s: string) => { e += s; }, isTTY: false },
    out: () => o, err: () => e,
  };
}
let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'dbc-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

test('no url and no DATABASE_URL -> 2', async () => {
  const io = capture(); assert.equal(await main([], {}, io, deps), 2); assert.match(io.err(), /DATABASE_URL/);
});
test('invalid --top -> 2', async () => assert.equal(await main(['postgres://a@h/db', '--top', 'abc'], {}, capture(), deps), 2));
test('invalid --watch -> 2', async () => assert.equal(await main(['postgres://a@h/db', '--watch', '0'], {}, capture(), deps), 2));
test('--help -> 0 with usage', async () => {
  const io = capture(); assert.equal(await main(['--help'], {}, io, deps), 0); assert.match(io.out(), /Penggunaan/);
});
test('DATABASE_URL used, password never printed, file written', async () => {
  const io = capture(); const file = join(dir, 'r.md');
  assert.equal(await main(['--output', file], { DATABASE_URL: 'postgres://app:secret@h/shop' }, io, deps), 0);
  const md = await readFile(file, 'utf8');
  assert.match(md, /^# Laporan db-checkup/);
  assert.ok(!io.out().includes('secret') && !md.includes('secret'));
  assert.ok(md.includes('postgres://app:***@h/shop'));
});
test('password in query param never printed', async () => {
  const io = capture(); const file = join(dir, 'q.md');
  const url = 'postgres://app@h/shop?password=s3cretQ&sslmode=require';
  assert.equal(await main([url, '--output', file], {}, io, deps), 0);
  const failing = { createAdapter: async () => { throw new Error(`bad ${url}`); } };
  const io2 = capture();
  assert.equal(await main([url], {}, io2, failing), 1);
  const md = await readFile(file, 'utf8');
  for (const t of [io.out(), io.err(), io2.err(), md]) assert.ok(!t.includes('s3cretQ'), t);
});
test('connection failure -> 1, password redacted in message', async () => {
  const io = capture();
  const failing = { createAdapter: async () => { throw new Error('connect ECONNREFUSED for postgres://app:secret@h/shop'); } };
  assert.equal(await main(['postgres://app:secret@h/shop'], {}, io, failing), 1);
  assert.match(io.err(), /^Gagal konek ke database:/); assert.ok(!io.err().includes('secret'));
});
test('password with malformed %-escape still redacted', async () => {
  const io = capture();
  const failing = { createAdapter: async () => { throw new Error('auth failed, password 100% wrong'); } };
  assert.equal(await main(['postgres://app:100%@h/shop'], {}, io, failing), 1);
  assert.ok(!io.err().includes('100%'), io.err());
});
test('close() error is swallowed', async () => {
  const d = { createAdapter: async () => fakeAdapter({ close: async () => { throw new Error('close boom'); } }) };
  assert.equal(await main(['postgres://a@h/db'], {}, capture(), d), 0);
});
test('adapter closed even when analysis throws', async () => {
  let closed = 0;
  const d = { createAdapter: async () => fakeAdapter({ info: async () => { throw new Error('boom'); }, close: async () => { closed++; } }) };
  assert.equal(await main(['postgres://a@h/db'], {}, capture(), d), 1);
  assert.equal(closed, 1);
});
test('redact: raw and percent-encoded password', () => {
  assert.equal(redact('x p@ss y', 'postgres://a:p%40ss@h/d'), 'x *** y');
  assert.equal(redact('x p%40ss y', 'postgres://a:p%40ss@h/d'), 'x *** y');
  assert.equal(redact('x 100% y', 'postgres://a:100%@h/d'), 'x *** y');
  assert.equal(redact('x', undefined), 'x');
});
