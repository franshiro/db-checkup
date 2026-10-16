import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractColumnUsage, normalizeDigest, SqlParseError } from '../src/sql-usage.js';
import type { TableInfo } from '../src/types.js';

const pgTables: TableInfo[] = [
  { table: 'public.orders', rows: 50000, columns: ['id', 'customer_id', 'status', 'created_at'] },
  { table: 'public.customers', rows: 20000, columns: ['id', 'email'] }];
test('eq, range, order with alias', () => {
  const r = extractColumnUsage('SELECT * FROM orders o WHERE o.customer_id = $1 AND created_at > $2 ORDER BY o.created_at DESC', 'postgres', 'public', pgTables);
  assert.deepEqual(r.aliases, { o: 'public.orders', orders: 'public.orders' });
  assert.deepEqual(r.usage, [
    { table: 'public.orders', column: 'customer_id', kind: 'eq' },
    { table: 'public.orders', column: 'created_at', kind: 'range' },
    { table: 'public.orders', column: 'created_at', kind: 'order' }]);
});
test('join ON is eq on both sides, unqualified column resolved via table columns', () =>
  assert.deepEqual(extractColumnUsage('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE email = $1', 'postgres', 'public', pgTables).usage, [
    { table: 'public.customers', column: 'id', kind: 'eq' },
    { table: 'public.orders', column: 'customer_id', kind: 'eq' },
    { table: 'public.customers', column: 'email', kind: 'eq' }]));
test('ambiguous unqualified column skipped', () =>
  assert.ok(!extractColumnUsage('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE id = $1', 'postgres', 'public', pgTables)
    .usage.some(u => u.kind === 'eq' && u.column === 'id' && u.table === 'public.orders')));
test('mysql digest with IN (...)', () => {
  const t: TableInfo[] = [{ table: 'shop.orders', rows: 50000, columns: ['status', 'customer_id'] }];
  const sql = normalizeDigest('SELECT * FROM `orders` WHERE `status` IN (...) AND `customer_id` = ?');
  assert.deepEqual(extractColumnUsage(sql, 'mysql', 'shop', t).usage, [
    { table: 'shop.orders', column: 'status', kind: 'eq' },
    { table: 'shop.orders', column: 'customer_id', kind: 'eq' }]);
});
test('unparseable throws SqlParseError', () =>
  assert.throws(() => extractColumnUsage('SELEC nonsense ((', 'postgres', 'public', pgTables), SqlParseError));
test('update/delete use where; between is range, like is not; case-insensitive; dedupe', () => {
  assert.deepEqual(extractColumnUsage('UPDATE Orders SET status = $1 WHERE ID = $2', 'postgres', 'public', pgTables).usage,
    [{ table: 'public.orders', column: 'id', kind: 'eq' }]);
  assert.deepEqual(extractColumnUsage('DELETE FROM orders WHERE created_at BETWEEN $1 AND $2 AND status LIKE $3', 'postgres', 'public', pgTables).usage, [
    { table: 'public.orders', column: 'created_at', kind: 'range' }]);
});
test('OR keeps only usages common to every branch', () => {
  const t: TableInfo[] = [{ table: 'public.orders', rows: 50000, columns: ['a', 'b', 'status'] }];
  const u = (where: string) => extractColumnUsage(`SELECT * FROM orders o WHERE ${where}`, 'postgres', 'public', t).usage;
  assert.deepEqual(u('o.a = $1 OR o.a = $2'), [{ table: 'public.orders', column: 'a', kind: 'eq' }]);
  assert.deepEqual(u('a = $1 OR b = $2'), []);
  assert.deepEqual(u('(o.a = $1 AND o.b > $2) OR (o.a = $3 AND o.b > $4)'), [
    { table: 'public.orders', column: 'a', kind: 'eq' }, { table: 'public.orders', column: 'b', kind: 'range' }]);
  assert.deepEqual(u('(o.a = $1 AND o.b > $2) OR o.status = $3'), []);
});
test('mysql backtick-quoted qualifier resolves', () =>
  assert.deepEqual(extractColumnUsage('SELECT * FROM `orders` `o` WHERE `o`.`customer_id` = ?', 'mysql', 'shop', [{ table: 'shop.orders', rows: 1, columns: [] }]).usage,
    [{ table: 'shop.orders', column: 'customer_id', kind: 'eq' }]));
