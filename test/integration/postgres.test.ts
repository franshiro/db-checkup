import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createPostgresAdapter } from '../../src/adapters/postgres.js';
import { analyze } from '../../src/analyze.js';

const skip = process.env.DB_CHECKUP_IT !== '1';
const urls = ['postgres://postgres:test@localhost:54312/postgres', 'postgres://postgres:test@localhost:54316/postgres'];

// The init script restarts the server once; wait until the seeded data is visible.
async function connectWhenReady(url: string): Promise<pg.Client> {
  for (let i = 0; i < 60; i++) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      if ((await c.query(`SELECT count(*)::int n FROM pg_class WHERE relname = 'orders'`)).rows[0].n) return c;
      await c.end();
    } catch { await c.end().catch(() => {}); }
    await delay(1000);
  }
  throw new Error(`database not ready: ${url}`);
}

for (const url of urls) {
  test(`postgres adapter suggests the missing FK index (${url})`, { skip }, async () => {
    const client = await connectWhenReady(url);
    const indexCount = async () => (await client.query(`SELECT count(*)::int n FROM pg_indexes WHERE tablename = 'orders'`)).rows[0].n;
    try {
      for (let i = 0; i < 5; i++) await client.query('SELECT * FROM orders WHERE customer_id = 42');
      const before = await indexCount();
      const adapter = await createPostgresAdapter(url);
      try {
        const stat = (await adapter.statements()).find(s => /customer_id = \$1/.test(s.query));
        assert.ok(stat, 'seeded query present in pg_stat_statements');
        assert.deepEqual(await adapter.explain(stat), [{ table: 'public.orders' }]);

        const result = await analyze(adapter, { connection: 'x', top: 10 });
        assert.ok(result.suggestions.ok);
        assert.ok(result.suggestions.value.items.some(i => i.table === 'public.orders' && i.confidence === 'tinggi'
          && i.columns.join() === 'customer_id'));
        assert.ok(result.foreignKeys.ok);
        assert.ok(result.foreignKeys.value.some(f => f.table === 'public.orders' && f.columns.join() === 'customer_id'));
      } finally { await adapter.close(); }
      assert.equal(await indexCount(), before);
      const left = await client.query(`SELECT 1 FROM pg_stat_statements WHERE query ~ 'customer_id = \\$1'`);
      assert.ok(left.rowCount! > 0, 'pg_stat_statements not reset');
    } finally { await client.end(); }
  });
}

for (const url of urls) {
  test(`explain refuses multi-statement and DML-CTE queries (${url})`, { skip }, async () => {
    const client = await connectWhenReady(url);
    const adapter = await createPostgresAdapter(url);
    const stat = (query: string) => ({ key: 'x', query, calls: 1, totalMs: 1, meanMs: 1, rows: 0 });
    try {
      await assert.rejects(adapter.explain(stat("SELECT 1; SET application_name = 'dbc_probe'; SELECT 1")));
      await assert.rejects(adapter.explain(stat('WITH d AS (DELETE FROM orders RETURNING id) SELECT * FROM d')), /bukan SELECT/);
      const { rows } = await client.query(`SELECT application_name FROM pg_stat_activity WHERE application_name IN ('db-checkup', 'dbc_probe')`);
      assert.deepEqual(rows.map(r => r.application_name), ['db-checkup']);
    } finally { await adapter.close(); await client.end(); }
  });
}

for (const url of urls) {
  test(`partial indexes are reported unused but never count as coverage (${url})`, { skip }, async () => {
    const client = await connectWhenReady(url);
    await client.query('CREATE INDEX dbc_it_partial ON orders (customer_id) WHERE id < 0');
    const adapter = await createPostgresAdapter(url);
    try {
      assert.ok((await adapter.unusedIndexes(50)).some(i => i.name === 'dbc_it_partial'));
      assert.ok(!(await adapter.indexes()).some(i => i.name === 'dbc_it_partial'));
    } finally { await adapter.close(); await client.query('DROP INDEX dbc_it_partial'); await client.end(); }
  });
}

for (const url of urls) {
  test(`postgres adapter serverConfig (${url})`, { skip }, async () => {
    const adapter = await createPostgresAdapter(url);
    try {
      const f = await adapter.serverConfig();
      const pg16 = url.includes(':54316');
      assert.equal(f.flavor, 'postgres');
      assert.match(f.version, /^\d+(\.\d+)*$/);
      assert.equal(f.settings.shared_buffers.bytes, 134217728);
      assert.equal(f.settings.shared_buffers.restart, true);
      assert.equal(f.settings.work_mem.restart, false);
      assert.equal(f.settings.track_activity_query_size.value, '1024');
      assert.equal('reserved_connections' in f.settings, pg16);
      assert.ok(f.connections.used >= 1);
      assert.ok(f.connections.groups.some(g => g.user === 'postgres'));
      assert.equal(f.pgStatStatements?.preloaded, true);
    } finally { await adapter.close(); }
  });
}
