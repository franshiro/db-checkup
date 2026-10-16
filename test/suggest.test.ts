import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestIndexes, createIndexSql, indexName } from '../src/suggest.js';
import type { TableInfo, IndexInfo } from '../src/types.js';

const tables: TableInfo[] = [{ table: 'public.orders', rows: 50000, columns: ['id', 'customer_id', 'status', 'created_at'] }];
const pk: IndexInfo = { table: 'public.orders', name: 'orders_pkey', columns: ['id'], unique: true, primary: true };
const base = { query: 'SELECT * FROM orders WHERE customer_id = $1 AND created_at > $2 ORDER BY created_at', dialect: 'postgres' as const,
               defaultSchema: 'public', scans: [{ table: 'public.orders' }], tables, indexes: [pk] };
test('full scan + eq -> tinggi', () => {
  const [s] = suggestIndexes(base);
  assert.deepEqual(s.columns, ['customer_id', 'created_at']);
  assert.equal(s.confidence, 'tinggi');
  assert.equal(s.sql, 'CREATE INDEX CONCURRENTLY idx_orders_customer_id_created_at ON orders (customer_id, created_at);');
  assert.match(s.reason, /Seq Scan pada `orders` \(50\.000 baris\)/);
});
test('full scan, range only -> sedang', () =>
  assert.equal(suggestIndexes({ ...base, query: 'SELECT * FROM orders WHERE created_at > $1' })[0].confidence, 'sedang'));
test('no plan -> rendah with reason', () => {
  const [s] = suggestIndexes({ ...base, scans: null, noPlanReason: 'contoh query terpotong' });
  assert.equal(s.confidence, 'rendah'); assert.match(s.reason, /contoh query terpotong/);
});
test('small table skipped', () => assert.deepEqual(suggestIndexes({ ...base, tables: [{ ...tables[0], rows: 500 }] }), []));
test('existing index with same leading columns skipped', () =>
  assert.deepEqual(suggestIndexes({ ...base, indexes: [pk, { ...pk, name: 'x', primary: false, unique: false, columns: ['customer_id', 'created_at', 'status'] }] }), []));
test('mysql alias from plan resolved, mysql template', () =>
  assert.equal(suggestIndexes({ query: 'SELECT * FROM `orders` `o` WHERE `o`.`customer_id` = ?', dialect: 'mysql', defaultSchema: 'shop',
    scans: [{ table: 'o' }], tables: [{ ...tables[0], table: 'shop.orders' }], indexes: [] })[0].sql,
    'CREATE INDEX idx_orders_customer_id ON orders (customer_id) ALGORITHM=INPLACE, LOCK=NONE;'));
test('quoting, non-default schema, name length', () => {
  assert.equal(createIndexSql('postgres', 'billing.OrderItems', ['userId'], 'public'),
    'CREATE INDEX CONCURRENTLY idx_orderitems_userid ON billing."OrderItems" ("userId");');
  assert.equal(createIndexSql('mysql', 'shop.orders', ['order'], 'shop'), 'CREATE INDEX idx_orders_order ON orders (`order`) ALGORITHM=INPLACE, LOCK=NONE;');
  assert.equal(indexName('public.t', ['a'.repeat(70)]).length, 63);
});
test('usage on table not in tables (CTE) yields nothing', () =>
  assert.deepEqual(suggestIndexes({ ...base, query: 'WITH c AS (SELECT 1 AS x) SELECT * FROM c WHERE x = 1', scans: null }), []));
test('LIKE predicate yields no suggestion', () =>
  assert.deepEqual(suggestIndexes({ ...base, query: 'SELECT * FROM customers WHERE email LIKE $1', scans: [{ table: 'public.customers' }],
    tables: [{ table: 'public.customers', rows: 50000, columns: ['id', 'email'] }] }), []));
test('no plan, case-insensitive match, duplicates deduped', () => {
  const [s] = suggestIndexes({ ...base, query: 'SELECT * FROM Orders WHERE customer_id = $1 AND customer_id = $2', scans: null, noPlanReason: 'x' });
  assert.deepEqual(s.columns, ['customer_id']);
});
