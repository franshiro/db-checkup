import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';
import { SkipError } from '../src/types.js';
import { fakeAdapter } from './helpers.js';

test('SkipError isolates one analysis', async () => {
  const r = await analyze(fakeAdapter({ statements: async () => { throw new SkipError('pg_stat_statements belum aktif'); } }), { connection: 'c', top: 10 });
  assert.deepEqual(r.cumulative, { ok: false, reason: 'pg_stat_statements belum aktif' });
  assert.equal(r.tableScans.ok, true);
});
test('generic DB error is masked', async () => {
  const r = await analyze(fakeAdapter({ tableScans: async () => { throw new Error("value 'budi@x.com' too long"); } }), { connection: 'c', top: 10 });
  assert.deepEqual(r.tableScans, { ok: false, reason: 'Gagal: value ? too long' });
});
test('access denied uses describeError', async () => {
  const r = await analyze(fakeAdapter({ lockWaits: async () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); } }), { connection: 'c', top: 10 });
  assert.deepEqual(r.locks, { ok: false, reason: 'Beri role pg_read_all_stats' });
});
test('own/system queries filtered, top applied', async () => {
  const st = (key: string, q: string, t: number) => ({ key, query: q, calls: 1, totalMs: t, meanMs: t, rows: 0 });
  const r = await analyze(fakeAdapter({ statements: async () => [st('1', 'EXPLAIN SELECT 1', 99), st('2', 'SELECT * FROM a', 5), st('3', 'SELECT * FROM b', 7)] }), { connection: 'c', top: 1 });
  assert.deepEqual(r.cumulative.ok && r.cumulative.value.map(s => s.key), ['3']);
});
test('watch: ticks each second then diffs', async () => {
  const snaps = [[{ key: 'a', query: 'SELECT 1 FROM t', calls: 10, totalMs: 100, meanMs: 10, rows: 0 }],
                 [{ key: 'a', query: 'SELECT 1 FROM t', calls: 13, totalMs: 160, meanMs: 12.3, rows: 0 }]];
  const slept: number[] = [], ticks: number[] = [];
  const r = await analyze(fakeAdapter({ statements: async () => snaps.shift()! }),
    { connection: 'c', top: 10, watchSeconds: 3, sleep: async ms => { slept.push(ms); }, onTick: s => ticks.push(s) });
  assert.deepEqual(slept, [1000, 1000, 1000]); assert.deepEqual(ticks, [3, 2, 1]);
  assert.equal(r.current!.ok && r.current!.value[0].totalMs, 60);
});
test('explain failure falls back to rendah; parse failure goes to skipped', async () => {
  const st = (key: string, q: string) => ({ key, query: q, calls: 1, totalMs: 10, meanMs: 10, rows: 0 });
  const r = await analyze(fakeAdapter({
    statements: async () => [st('1', 'SELECT * FROM orders WHERE customer_id = $1'), st('2', 'SELECT nonsense ((')],
    explain: async () => { throw new Error('could not determine data type of parameter $1'); },
    tables: async () => [{ table: 'public.orders', rows: 50000, columns: ['customer_id'] }] }), { connection: 'c', top: 10 });
  assert.ok(r.suggestions.ok);
  assert.equal(r.suggestions.value.items[0].confidence, 'rendah');
  assert.match(r.suggestions.value.items[0].reason, /could not determine data type/);
  assert.equal(r.suggestions.value.skipped[0].reason, 'SQL tidak bisa di-parse');
});
test('unparseable non-SELECT/DML statements are skipped silently', async () => {
  const r = await analyze(fakeAdapter({ statements: async () => [{ key: '1', query: 'ANALYZE ((', calls: 1, totalMs: 10, meanMs: 10, rows: 0 }] }), { connection: 'c', top: 10 });
  assert.ok(r.suggestions.ok && r.suggestions.value.skipped.length === 0);
});
test('postgres error messages: double-quoted values are masked', async () => {
  const r = await analyze(fakeAdapter({ statements: async () => { throw new Error('invalid input syntax for type integer: "budi@x.com"'); } }), { connection: 'c', top: 10 });
  assert.ok(!r.cumulative.ok && !r.cumulative.reason.includes('budi'), JSON.stringify(r.cumulative));
});
const boom = (n: string) => async () => { throw new Error(`unexpected ${n}`); };
test('parts: only running and locks touch the database', async () => {
  const r = await analyze(fakeAdapter({ statements: boom('statements'), tables: boom('tables'), indexes: boom('indexes'), tableScans: boom('tableScans'),
    unindexedForeignKeys: boom('fk'), unusedIndexes: boom('unused'), explain: boom('explain') }), { connection: 'c', top: 10, parts: ['running', 'locks'] });
  assert.deepEqual(Object.entries(r).filter(([k, v]) => v !== undefined && !['connection', 'info'].includes(k)).map(([k]) => k).sort(), ['locks', 'running']);
});
test('parts: suggestions takes its own statement snapshot', async () => {
  let calls = 0;
  const r = await analyze(fakeAdapter({ statements: async () => { calls++; return []; } }), { connection: 'c', top: 10, parts: ['suggestions'] });
  assert.equal(calls, 1); assert.equal(r.cumulative, undefined); assert.equal(r.suggestions?.ok, true);
});
test('abort during countdown rejects with AbortError and stops sleeping', async () => {
  const ac = new AbortController(); let slept = 0, ticks = 0;
  await assert.rejects(analyze(fakeAdapter(), { connection: 'c', top: 10, watchSeconds: 3, signal: ac.signal,
    sleep: async () => { slept++; }, onTick: () => { if (++ticks === 2) ac.abort(); } }), (e: Error) => e.name === 'AbortError');
  assert.equal(slept, 1);
});
test('abort before a step skips it', async () => {
  const ac = new AbortController(); let scanned = false;
  await assert.rejects(analyze(fakeAdapter({ tableScans: async () => { ac.abort(); return []; }, unindexedForeignKeys: async () => { scanned = true; return []; } }),
    { connection: 'c', top: 10, parts: ['foreignKeys', 'tableScans'], signal: ac.signal }), (e: Error) => e.name === 'AbortError');
  assert.equal(scanned, false);
});
