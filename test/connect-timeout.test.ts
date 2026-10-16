import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createPostgresAdapter } from '../src/adapters/postgres.js';

test('postgres connect rejects when server accepts TCP but never answers', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer(s => { sockets.push(s); }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const { port } = server.address() as net.AddressInfo;
    const t = Date.now();
    await assert.rejects(createPostgresAdapter(`postgres://u:p@127.0.0.1:${port}/db`, 300), /timeout/i);
    assert.ok(Date.now() - t < 5000);
  } finally { sockets.forEach(s => s.destroy()); server.close(); }
});
