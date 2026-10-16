import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionUrl, redactUrl } from '../src/connection.js';

test('postgres url kept as-is', () => {
  const c = parseConnectionUrl('postgresql://app:s%40cret@db.local:5433/shop?sslmode=require');
  assert.deepEqual(c, { dialect: 'postgres', url: 'postgresql://app:s%40cret@db.local:5433/shop?sslmode=require', database: 'shop' });
});
test('postgres without database falls back to user', () =>
  assert.equal(parseConnectionUrl('postgres://app@h').database, 'app'));
test('mysql url decoded, default port, ssl=true', () =>
  assert.deepEqual(parseConnectionUrl('mysql://root:p%23ss@10.0.0.5/shop?ssl=true'), {
    dialect: 'mysql', database: 'shop',
    mysql: { host: '10.0.0.5', port: 3306, user: 'root', password: 'p#ss', database: 'shop', ssl: {} } }));
test('mysql ssl=skip-verify', () =>
  assert.deepEqual((parseConnectionUrl('mysql://u@h/db?ssl=skip-verify') as any).mysql.ssl, { rejectUnauthorized: false }));
test('mysql without database throws', () =>
  assert.throws(() => parseConnectionUrl('mysql://root@h/'), /nama database/));
test('unknown scheme throws', () =>
  assert.throws(() => parseConnectionUrl('redis://h'), /postgres:\/\/ atau mysql:\/\//));
test('redactUrl hides password only', () => {
  assert.equal(redactUrl('postgres://app:secret@h/db'), 'postgres://app:***@h/db');
  assert.equal(redactUrl('mysql://app@h/db'), 'mysql://app@h/db');
});
test('malformed %-escape -> Indonesian error without url', () =>
  assert.throws(() => parseConnectionUrl('mysql://root:pa%zzss@h/db'), (e: Error) => /escape persen/.test(e.message) && !e.message.includes('pa%zzss')));
