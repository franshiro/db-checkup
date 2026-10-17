import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, localMemory, hostOf } from '../src/sysmem.js';
import type { ConnectionConfig } from '../src/connection.js';

test('isLocalHost', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '/var/run/postgresql', '']) assert.equal(isLocalHost(h), true, h);
  for (const h of ['db.toko.id', '10.0.0.5']) assert.equal(isLocalHost(h), false, h);
});

test('localMemory', async () => {
  const fake = async () => 'MemTotal:       8000000 kB\nMemAvailable:  2048000 kB\n';
  const linux = await localMemory(fake, 'linux');
  assert.ok(linux.totalMb > 0);
  assert.equal(linux.availableMb, 2000);
  assert.equal((await localMemory(fake, 'darwin')).availableMb, undefined);
  const broken = await localMemory(async () => { throw new Error('no proc'); }, 'linux');
  assert.equal(broken.availableMb, undefined);
});

test('hostOf', () => {
  const pg = (url: string): ConnectionConfig => ({ dialect: 'postgres', url, database: 'db' });
  assert.equal(hostOf(pg('postgres://u@h:5/db')), 'h');
  assert.equal(hostOf(pg('postgres:///db?host=/tmp')), '/tmp');
  assert.equal(hostOf(pg('postgres://u@[::1]:5432/db')), '::1');
  const my: ConnectionConfig = { dialect: 'mysql', database: 'db', mysql: { host: 'mysql.toko.id', port: 3306, user: 'u', password: 'p', database: 'db' } };
  assert.equal(hostOf(my), 'mysql.toko.id');
});
