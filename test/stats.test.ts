import test from 'node:test';
import assert from 'node:assert/strict';
import type { StatementStat } from '../src/types.js';
import { topByTotal, diffStatements, isOwnOrSystemQuery } from '../src/stats.js';

const s = (key: string, totalMs: number, calls = 1): StatementStat => ({ key, query: key, calls, totalMs, meanMs: totalMs / calls, rows: 0 });
test('topByTotal', () => assert.deepEqual(topByTotal([s('a', 5), s('b', 9), s('c', 1)], 2).map(x => x.key), ['b', 'a']));
test('diff: delta, new entry counted from zero', () => {
  const d = diffStatements([s('a', 100, 10)], [s('a', 160, 13), s('b', 7, 1)]);
  assert.deepEqual(d.find(x => x.key === 'a'), { ...s('a', 60, 3) });
  assert.equal(d.find(x => x.key === 'b')!.totalMs, 7);
});
test('diff: unchanged dropped', () => assert.deepEqual(diffStatements([s('a', 5)], [s('a', 5)]), []));
test('diff: reset between snapshots uses second value', () => {
  const [a] = diffStatements([s('a', 100, 10)], [s('a', 30, 2)]);
  assert.equal(a.totalMs, 30); assert.equal(a.calls, 2);
});
test('isOwnOrSystemQuery', () => {
  for (const q of ['EXPLAIN SELECT 1', 'SET statement_timeout = 5000', 'PREPARE x AS SELECT 1', 'DEALLOCATE x', 'SHOW server_version_num',
                   'SELECT * FROM pg_stat_statements', 'SELECT * FROM performance_schema.processlist', 'SELECT * FROM information_schema.TABLES',
                   'SELECT * FROM sys.innodb_lock_waits', 'SELECT oid FROM pg_catalog.pg_class',
                   'SELECT ix.indexrelid FROM pg_index ix', 'SELECT VERSION()', 'SELECT version()', 'SELECT @@transaction_read_only',
                   'SELECT `VERSION` ( ) AS `v`', 'SELECT `a` FROM `sys` . `innodb_lock_waits`'])
    assert.equal(isOwnOrSystemQuery(q), true, q);
  assert.equal(isOwnOrSystemQuery('SELECT * FROM t WHERE tsv @@ to_tsquery($1)'), false);
  assert.equal(isOwnOrSystemQuery('SELECT * FROM orders WHERE customer_id = $1'), false);
});
