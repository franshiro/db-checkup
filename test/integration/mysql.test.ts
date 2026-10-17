import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import type { MysqlOptions } from '../../src/connection.js';
import { createMysqlAdapter } from '../../src/adapters/mysql.js';
import { analyze } from '../../src/analyze.js';

const skip = process.env.DB_CHECKUP_IT !== '1';
const servers: { name: string; opts: MysqlOptions }[] = [
  { name: 'mysql80', opts: { host: '127.0.0.1', port: 33080, user: 'root', password: 'test', database: 'shop' } },
  { name: 'mariadb', opts: { host: '127.0.0.1', port: 33110, user: 'root', password: 'test', database: 'shop' } },
];

// The entrypoint runs the init script on a temporary server; wait until the seeded data is visible.
async function connectWhenReady(opts: MysqlOptions): Promise<mysql.Connection> {
  for (let i = 0; i < 120; i++) {
    try {
      const c = await mysql.createConnection(opts);
      try {
        const [rows] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = 'orders' AND TABLE_ROWS > 40000`);
        if ((rows as { n: number }[])[0].n) return c;
      } catch { /* init still running */ }
      await c.end().catch(() => {});
    } catch { /* not accepting connections yet */ }
    await delay(1000);
  }
  throw new Error(`database not ready: ${opts.port}`);
}

for (const { name, opts } of servers) {
  test(`mysql adapter suggests the missing index (${name})`, { skip }, async () => {
    const client = await connectWhenReady(opts);
    const indexCount = async () => ((await client.query(`SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = 'orders'`))[0] as { n: number }[])[0].n;
    try {
      for (let i = 0; i < 5; i++) await client.query('SELECT * FROM orders WHERE customer_id = 42');
      const before = await indexCount();
      const adapter = await createMysqlAdapter(opts);
      try {
        const result = await analyze(adapter, { connection: 'x', top: 10 });
        assert.ok(result.suggestions.ok);
        const item = result.suggestions.value.items.find(i => i.table === 'shop.orders' && i.columns.join() === 'customer_id');
        assert.ok(item, 'suggestion for shop.orders(customer_id)');
        if (name === 'mariadb') {
          const info = await adapter.info();
          assert.equal(info.flavor, 'mariadb');
          assert.ok(info.warnings.length > 0);
          assert.equal(item.confidence, 'rendah');
        } else {
          assert.equal(item.confidence, 'tinggi');
        }
        assert.ok(!result.foreignKeys.ok);
        assert.match(result.foreignKeys.reason, /InnoDB/);
      } finally { await adapter.close(); }
      assert.equal(await indexCount(), before);
    } finally { await client.end(); }
  });
}

for (const { name, opts } of servers) {
  test(`explain refuses multi-statement and DML-CTE samples (${name})`, { skip }, async () => {
    const client = await connectWhenReady(opts);
    const ids = async () => ((await client.query('SELECT ID FROM information_schema.PROCESSLIST'))[0] as { ID: number }[]).map(r => Number(r.ID));
    const others = await ids();
    const adapter = await createMysqlAdapter(opts);
    const adapterId = (await ids()).find(id => !others.includes(id))!;
    const stat = (sample: string) => ({ key: 'x', query: sample, sample, calls: 1, totalMs: 1, meanMs: 1, rows: 0 });
    try {
      if (name === 'mariadb') {   // plans are never used on MariaDB, so the server-side checks below only apply to mysql80
        await assert.rejects(adapter.explain(stat('SELECT * FROM orders WHERE customer_id = 42')), /MariaDB: rencana eksekusi tidak dipakai/);
        return;
      }
      // multibyte sample: few chars, but bytes at the limit -> truncated
      const limit = Number(((await client.query('SELECT @@performance_schema_max_sql_text_length AS n'))[0] as { n: number }[])[0].n);
      const multibyte = "SELECT '" + 'é'.repeat(Math.ceil(limit / 2) - 6) + "'";
      assert.ok(multibyte.length < limit && Buffer.byteLength(multibyte) >= limit - 3);
      await assert.rejects(adapter.explain(stat(multibyte)), /contoh query terpotong/);
      // rejected by the server's parser (1064): the second statement never runs
      await assert.rejects(adapter.explain(stat("SELECT 1; SET SESSION sql_mode=''")), { errno: 1064 });
      await assert.rejects(adapter.explain(stat('SELECT 1; SET @dbc_probe = 1')), { errno: 1064 });
      await assert.rejects(adapter.explain(stat('WITH d AS (SELECT 1) DELETE FROM orders WHERE id = 1')), /bukan SELECT/);
      await assert.rejects(adapter.explain(stat('DELETE FROM orders')), /bukan SELECT/);
      assert.deepEqual(await adapter.explain(stat('SELECT * FROM orders WHERE customer_id = 42')), [{ table: 'orders' }]);
      // the adapter session is still read-only and untouched (MySQL only: MariaDB has no per-thread variable tables)
      if (name === 'mysql80') {
        const thread = `(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = ${adapterId})`;
        const [ro] = await client.query(`SELECT VARIABLE_VALUE AS v FROM performance_schema.variables_by_thread WHERE THREAD_ID = ${thread} AND VARIABLE_NAME = 'transaction_read_only'`);
        assert.deepEqual((ro as { v: string }[]).map(r => r.v), ['ON']);
        const [uv] = await client.query(`SELECT 1 FROM performance_schema.user_variables_by_thread WHERE THREAD_ID = ${thread} AND VARIABLE_NAME = 'dbc_probe'`);
        assert.equal((uv as unknown[]).length, 0);
      }
    } finally { await adapter.close(); await client.end(); }
  });
}

for (const { name, opts } of servers) {
  test(`mysql adapter serverConfig (${name})`, { skip }, async () => {
    const adapter = await createMysqlAdapter(opts);
    try {
      const f = await adapter.serverConfig();
      assert.equal(f.flavor, name === 'mariadb' ? 'mariadb' : 'mysql');
      assert.match(f.version, /^\d+(\.\d+)*$/);
      assert.ok(f.settings.innodb_buffer_pool_size.bytes! > 0);
      assert.ok(f.connections.peak! >= 1);
      assert.equal(f.connections.partial, false);
      assert.ok(f.connections.groups.some(g => g.user === 'root'));
      assert.ok(f.connections.groups.some(g => g.database === 'shop'));
      if (name === 'mariadb') assert.ok(f.settings.aria_pagecache_buffer_size);
      else assert.equal(f.digestConsumer, true);
    } finally { await adapter.close(); }
  });
}
