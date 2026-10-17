import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConfig, formatSize, parseSize, MYSQL_STATIC, type ServerFacts, type ServerMemory, type Setting, type Flavor } from '../src/config.js';

const MB = 1048576;
const size = (mb: number, restart = false): Setting => ({ value: String(mb * MB), bytes: mb * MB, restart });
const val = (value: string, restart = false): Setting => ({ value, restart });
const today = new Date(2026, 9, 17);
const conns = (max = 100, extra: Partial<ServerFacts['connections']> = {}): ServerFacts['connections'] =>
  ({ max, reserved: 0, used: 5, partial: false, groups: [], ...extra });

const pg = (max = 100, settings: Record<string, Setting> = {}, extra: Partial<ServerFacts> = {}): ServerFacts => ({
  flavor: 'postgres', version: '16.4', connections: conns(max),
  pgStatStatements: { preloaded: true, created: true },
  settings: {
    shared_buffers: size(128, true), effective_cache_size: size(4096), work_mem: size(4), maintenance_work_mem: size(64),
    autovacuum_work_mem: val('-1'), autovacuum_max_workers: val('3', true), max_connections: val(String(max), true),
    shared_preload_libraries: val('pg_stat_statements', true), track_io_timing: val('on'), track_activity_query_size: val('4096', true),
    log_min_duration_statement: val('1000'), idle_in_transaction_session_timeout: val('0'), ...settings,
  }, ...extra,
});
const my = (flavor: Flavor = 'mysql', version = '8.0.39', settings: Record<string, Setting> = {}, extra: Partial<ServerFacts> = {}): ServerFacts => ({
  flavor, version, connections: conns(100), digestConsumer: true,
  settings: {
    innodb_buffer_pool_size: size(128), key_buffer_size: size(8), sort_buffer_size: size(1), join_buffer_size: size(1),
    read_buffer_size: size(1), read_rnd_buffer_size: size(1), thread_stack: size(1, true), binlog_cache_size: size(1),
    max_connections: val('100'), wait_timeout: val('28800'), interactive_timeout: val('28800'),
    performance_schema: val('ON', true), slow_query_log: val('ON'), long_query_time: val('1'),
    ...(flavor === 'mariadb' ? { aria_pagecache_buffer_size: size(128, true) } : {}), ...settings,
  }, ...extra,
});
const mem = (totalMb?: number, dedicated = true): ServerMemory => ({ totalMb, source: totalMb ? 'manual' : null, dedicated });
const rec = (r: ReturnType<typeof analyzeConfig>, s: string) => r.recs.find(x => x.setting === s);
const MEM_PG = ['shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'max_connections'];

test('parseSize / formatSize', () => {
  assert.equal(parseSize('8G'), 8192); assert.equal(parseSize('8GB'), 8192); assert.equal(parseSize('512m'), 512);
  assert.equal(parseSize('512MB'), 512); assert.equal(parseSize('1.5GB'), 1536); assert.equal(parseSize('1.5g'), 1536);
  assert.equal(parseSize('abc'), null); assert.equal(parseSize('8192'), null); assert.equal(parseSize('0G'), null);
  assert.equal(formatSize(4096), '4GB'); assert.equal(formatSize(40), '40MB'); assert.equal(formatSize(1536), '1536MB');
});

test('postgres dedicated 16GB: all four memory recs, worst after fits', () => {
  const r = analyzeConfig(pg(), mem(16384), today);
  assert.equal(r.memory.quotaMb, 16384);
  assert.deepEqual(['shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem'].map(s => rec(r, s)?.suggested), ['4GB', '12GB', '40MB', '819MB']);
  assert.equal(rec(r, 'shared_buffers')?.current, '128MB');
  assert.equal(rec(r, 'shared_buffers')?.restart, true);
  assert.equal(rec(r, 'max_connections'), undefined);
  assert.equal(r.memory.worstMb, 128 + 100 * 4 + 3 * 64);
  assert.equal(r.memory.worstAfterMb, 4096 + 100 * 40 + 3 * 819);
  assert.equal(r.memory.overflow, false);
});

test('postgres shared 16GB -> quota 8GB', () => {
  const r = analyzeConfig(pg(), mem(16384, false), today);
  assert.equal(r.memory.quotaMb, 8192);
  assert.deepEqual(['shared_buffers', 'work_mem', 'maintenance_work_mem'].map(s => rec(r, s)?.suggested), ['2GB', '20MB', '409MB']);
});

test('current within 50-150% and no overflow -> not listed', () => {
  const r = analyzeConfig(pg(100, { shared_buffers: size(3072, true) }), mem(16384), today);
  assert.equal(rec(r, 'shared_buffers'), undefined);
  assert.ok(rec(r, 'work_mem'));
});

test('postgres 1GB, 500 connections -> max_connections 170 + PgBouncer, worst after fits', () => {
  // cut judged against min(current, R): shared_buffers stays 128MB, (1024 - 128 - 3×64) ÷ 4 = 176 -> 170
  const r = analyzeConfig(pg(500), mem(1024), today);
  assert.equal(r.memory.overflow, true);
  assert.equal(rec(r, 'max_connections')?.suggested, '170');
  assert.equal(rec(r, 'shared_buffers'), undefined);
  assert.equal(rec(r, 'max_connections')?.restart, true);
  for (const s of ['work_mem', 'maintenance_work_mem']) { const x = rec(r, s); if (x) assert.match(x.suggested, /^(4|64)MB$/); }
  assert.ok(r.connections.advice.some(a => a.includes('PgBouncer')));
  assert.ok(r.memory.worstAfterMb! <= 1024);
});

test('recs never leave worst case above quota (partial apply would overflow)', () => {
  // current fits only because work_mem is tiny; recommending work_mem 4MB alone would overflow
  const r = analyzeConfig(pg(500, { shared_buffers: size(32, true), work_mem: size(1) }), mem(1024), today);
  assert.equal(r.memory.overflow, false);
  assert.ok(r.memory.worstAfterMb! <= 1024, `worstAfter ${r.memory.worstAfterMb}`);
  if (rec(r, 'work_mem')) assert.equal(rec(r, 'max_connections')?.suggested, '140');
});

test('postgres 256MB -> tooSmall, no memory recs', () => {
  const r = analyzeConfig(pg(100), mem(256), today);
  assert.equal(r.memory.tooSmall, true);
  assert.equal(r.memory.worstAfterMb, undefined);
  assert.ok(!r.recs.some(x => MEM_PG.includes(x.setting)));
});

test('mysql dedicated 8GB -> buffer pool 5GB, commands in bytes and my.cnf', () => {
  const r = analyzeConfig(my(), mem(8192), today);
  assert.equal(rec(r, 'innodb_buffer_pool_size')?.suggested, '5GB');
  assert.equal(r.memory.worstMb, 128 + 8 + 600);
  assert.equal(r.memory.worstAfterMb, 5120 + 8 + 600);
  const self = r.commands.find(c => c.platform === 'Server sendiri')!.lines;
  assert.ok(self.includes('SET PERSIST innodb_buffer_pool_size = 5368709120;'));
  assert.ok(self.includes('[mysqld]'));
  assert.ok(self.includes('innodb_buffer_pool_size = 5G'));
  assert.deepEqual(r.commands.map(c => c.platform), ['Server sendiri', 'AWS RDS', 'Google Cloud SQL']);
  for (const c of r.commands.slice(1)) {
    assert.ok(c.lines.includes('innodb_buffer_pool_size = 5368709120'));
    assert.ok(!c.lines.some(l => /\b(SET|ALTER|SELECT)\b/.test(l)));
  }
});

test('mariadb: aria counted, SET GLOBAL + my.cnf', () => {
  const r = analyzeConfig(my('mariadb', '10.11.8'), mem(8192), today);
  assert.equal(r.memory.worstMb, 128 + 8 + 128 + 600);
  const self = r.commands[0].lines;
  assert.ok(self.some(l => l.startsWith('SET GLOBAL innodb_buffer_pool_size = ')));
  assert.ok(!self.some(l => l.includes('PERSIST')));
  assert.ok(self.some(l => /^innodb_buffer_pool_size = \d+[MG]$/.test(l)));
});

test('unknown RAM -> skipped with --ram, other parts filled', () => {
  const f = pg(100, { track_io_timing: val('off') }, { connections: conns(100, { used: 90 }) });
  const r = analyzeConfig(f, mem(undefined), today);
  assert.match(r.memory.skipped!, /--ram/);
  assert.ok(!r.recs.some(x => MEM_PG.includes(x.setting)));
  assert.equal(r.connections.warn, true);
  assert.ok(r.readiness.length > 0);
  assert.equal(r.version.status, 'ok');
});

test('connections: effective, warn, peak, idle recs', () => {
  const a = analyzeConfig(pg(100, {}, { connections: conns(100, { reserved: 3, used: 80 }) }), mem(16384), today);
  assert.equal(a.connections.effective, 97); assert.equal(a.connections.warn, true); assert.equal(a.connections.usagePct, 82);
  assert.ok(a.connections.advice.some(x => x.includes('PgBouncer')));
  assert.equal(analyzeConfig(pg(), mem(16384), today).connections.warn, false);
  assert.equal(analyzeConfig(my('mysql', '8.0.39', {}, { connections: conns(100, { used: 10, peak: 95 }) }), mem(8192), today).connections.warn, true);
  const idle = { user: 'app', app: 'web', count: 4, idleLong: 2 };
  const p = analyzeConfig(pg(100, {}, { connections: conns(100, { groups: [{ ...idle, database: 'shop', state: 'idle in transaction' }] }) }), mem(16384), today);
  assert.equal(rec(p, 'idle_in_transaction_session_timeout')?.suggested, '60s');
  assert.ok(p.commands[0].lines.includes("ALTER SYSTEM SET idle_in_transaction_session_timeout = '60s';"));
  assert.ok(p.commands[1].lines.includes('idle_in_transaction_session_timeout = 60000'));
  const m = analyzeConfig(my('mysql', '8.0.39', {}, { connections: conns(100, { groups: [{ ...idle, state: 'Sleep' }] }) }), mem(8192), today);
  assert.equal(rec(m, 'wait_timeout')?.suggested, '600');
  assert.ok(m.commands[0].lines.includes('SET PERSIST wait_timeout = 600;'));
  assert.equal(rec(analyzeConfig(pg(), mem(16384), today), 'idle_in_transaction_session_timeout'), undefined);
});

test('readiness postgres', () => {
  const r = analyzeConfig(pg(100, { track_io_timing: val('off'), shared_preload_libraries: val('auto_explain', true) },
    { pgStatStatements: { preloaded: false, created: false } }), mem(16384), today);
  const pss = r.readiness.find(x => x.item.includes('pg_stat_statements'))!;
  assert.equal(pss.ok, false); assert.match(pss.fix!, /shared_preload_libraries/); assert.equal(pss.restart, true);
  assert.equal(r.readiness.find(x => x.item.includes('track_io_timing'))!.ok, false);
  assert.ok(r.readiness.filter(x => x.item.includes('track_activity') || x.item.includes('log_min')).every(x => x.ok));
  assert.ok(r.commands[0].lines.includes("ALTER SYSTEM SET shared_preload_libraries = 'auto_explain', 'pg_stat_statements';"));
  assert.ok(r.commands[0].lines.includes("ALTER SYSTEM SET track_io_timing = 'on';"));
  assert.ok(r.commands[1].lines.includes('track_io_timing = 1'));
  assert.ok(r.commands[2].lines.includes('track_io_timing = on'));
});

test('readiness mysql', () => {
  const r = analyzeConfig(my('mysql', '8.0.39', { performance_schema: val('OFF', true) }, { digestConsumer: false }), mem(8192), today);
  const ps = r.readiness.find(x => x.item.includes('performance_schema'))!;
  assert.equal(ps.ok, false); assert.match(ps.fix!, /\[mysqld\]/); assert.match(ps.fix!, /performance_schema = ON/); assert.equal(ps.restart, true);
  assert.match(r.readiness.find(x => x.item.includes('statements_digest'))!.fix!, /setup_consumers/);
  const self = r.commands[0].lines;
  assert.ok(!self.some(l => l.startsWith('SET') && l.includes('performance_schema')));
  assert.ok(self.includes('performance_schema = ON'));
  assert.ok(r.commands[1].lines.includes('performance_schema = 1'));
  assert.ok(MYSQL_STATIC.has('performance_schema'));
});

test('version status', () => {
  const st = (f: Flavor, v: string) => analyzeConfig(f === 'postgres' ? { ...pg(), version: v } : my(f, v), mem(undefined), today).version;
  assert.deepEqual(st('postgres', '12.20'), { major: '12', eol: '2024-11', status: 'eol' });
  assert.equal(st('postgres', '14.13').status, 'segera');
  assert.equal(st('postgres', '16.4').status, 'ok');
  assert.deepEqual(st('mysql', '8.0.39'), { major: '8.0', eol: '2026-04', status: 'eol' });
  assert.equal(st('mariadb', '10.11.8').status, 'ok');
  assert.deepEqual(st('postgres', '19.0'), { major: '19', status: 'unknown' });
});

test('postgres commands: ALTER SYSTEM, reload, restart note; RDS in base units', () => {
  const r = analyzeConfig(pg(), mem(16384), today);
  const self = r.commands[0].lines;
  assert.ok(self.includes("ALTER SYSTEM SET shared_buffers = '4GB';"));
  assert.ok(self.includes("ALTER SYSTEM SET work_mem = '40MB';"));
  assert.ok(self.includes('SELECT pg_reload_conf();'));
  assert.ok(self.some(l => l.startsWith('--') && /restart/i.test(l) && l.includes('shared_buffers')));
  const rds = r.commands[1].lines;
  assert.ok(rds.some(l => l.startsWith('shared_buffers = 524288')));
  assert.ok(rds.some(l => l.startsWith('work_mem = 40960')));
  assert.ok(!rds.some(l => /\b(SET|ALTER|SELECT)\b/.test(l)));
  assert.deepEqual(analyzeConfig(pg(), mem(undefined), today).commands, []);
});

test('full connections: raise advice only when memory allows going above current', () => {
  const tight = analyzeConfig(pg(500, {}, { connections: conns(500, { used: 480 }) }), mem(1024), today);
  assert.ok(!tight.connections.advice.some(a => a.includes('dinaikkan')));
  const roomy = analyzeConfig(my('mysql', '8.0.39', {}, { connections: conns(100, { used: 95 }) }), mem(8192), today);
  assert.ok(roomy.connections.advice.some(a => /dinaikkan sampai \d/.test(a)));
});

// R9: worst case with current values fits -> never touch max_connections, shrink listed increases instead.
const busy = (max: number, used: number, settings: Record<string, Setting> = {}) =>
  pg(max, settings, { connections: conns(max, { reserved: 3, used }) });
test('R9a: current fits, recommended set does not -> no max_connections cut, shrunk increases', () => {
  const r = analyzeConfig(busy(400, 350), mem(4096, false), today);   // stock PG16, J = 2048, worst now 1920
  assert.equal(r.memory.overflow, false);
  assert.equal(rec(r, 'max_connections'), undefined);
  assert.ok(!r.connections.advice.some(a => a.includes('memori tidak cukup')), r.connections.advice.join('|'));
  assert.ok(r.memory.worstAfterMb! <= 2048);
  assert.equal(rec(r, 'shared_buffers'), undefined);   // 512MB shrinks to 256MB, within 50-150% of 128MB
  const s = analyzeConfig(busy(400, 350, { shared_buffers: size(64, true) }), mem(4096, false), today);
  assert.equal(rec(s, 'shared_buffers')?.suggested, '256MB');
  assert.match(rec(s, 'shared_buffers')!.reason, /^Dibatasi/);   // shrunk, but still an increase over 64MB
  assert.equal(rec(s, 'max_connections'), undefined);
  assert.equal(s.memory.worstAfterMb, 2048);
});

test('R9b: overflow and fitting needs fewer connections than in use -> no cut, too-small message', () => {
  const r = analyzeConfig(busy(500, 171), mem(1024), today);   // fit with min(current, R) needs 170, in use rounds up to 180
  assert.equal(r.memory.overflow, true);
  assert.equal(r.memory.tooSmall, true);
  assert.equal(r.memory.tooSmallReason, 'RAM terlalu kecil untuk jumlah koneksi yang sedang dipakai');
  assert.ok(!r.recs.some(x => MEM_PG.includes(x.setting)));
  assert.ok(r.connections.advice.some(a => a.includes('PgBouncer')));
  const m = analyzeConfig(my('mysql', '8.0.39', {}, { connections: conns(100, { used: 10, peak: 70 }) }), mem(512), today);   // fit needs 60
  assert.equal(m.memory.tooSmallReason, 'RAM terlalu kecil untuk jumlah koneksi yang sedang dipakai');
  assert.equal(rec(m, 'max_connections'), undefined);
  assert.ok(m.connections.advice.some(a => a.includes('ProxySQL')) && m.connections.advice.some(a => a.includes('wait_timeout')));
});

test('R9b: overflow with low usage -> cut not below max(used, peak) rounded up to 10', () => {
  const r = analyzeConfig(busy(500, 135), mem(1024), today);
  assert.equal(rec(r, 'max_connections')?.suggested, '170');
  assert.ok(r.memory.worstAfterMb! <= 1024);
  const m = analyzeConfig(my('mysql', '8.0.39', {}, { connections: conns(100, { used: 10, peak: 55 }) }), mem(512), today);
  assert.equal(rec(m, 'max_connections')?.suggested, '60');
  assert.equal(m.memory.tooSmall, undefined);
});

test('no raise advice while current settings overflow', () => {
  // work_mem 64MB overflows 4GB now; the suggested set would leave room for more connections
  const r = analyzeConfig(busy(100, 90, { work_mem: size(64) }), mem(4096), today);
  assert.equal(r.memory.overflow, true);
  assert.equal(r.connections.warn, true);
  assert.ok(!r.connections.advice.some(a => a.includes('dinaikkan')), r.connections.advice.join('|'));
  assert.ok(r.connections.advice.some(a => a.includes('memori tidak cukup')));
});

// Overflow: lowering memory settings alone is preferred over a connection cut or the too-small verdict.
const memOnly = (r: ReturnType<typeof analyzeConfig>, J: number) => {
  assert.equal(r.memory.overflow, true);
  assert.equal(r.memory.tooSmall, undefined);
  assert.equal(rec(r, 'max_connections'), undefined);
  assert.ok(r.memory.worstAfterMb! <= J, `worstAfter ${r.memory.worstAfterMb}`);
  for (const x of r.recs) assert.notEqual(x.suggested, x.current);
};
test('overflow fixed by work_mem alone -> work_mem decrease, no cut, no too-small', () => {
  for (const used of [160, 100]) {   // 128 + 170×4 + 3×64 = 1000 <= 1024
    const r = analyzeConfig(busy(170, used, { work_mem: size(64) }), mem(1024), today);
    memOnly(r, 1024);
    assert.equal(rec(r, 'work_mem')?.suggested, '4MB');
    assert.match(rec(r, 'work_mem')!.reason, /^Diturunkan/);
    assert.equal(r.memory.worstAfterMb, 1000);
  }
});
test('overflow fixed by shared_buffers alone -> shared_buffers decrease (the real cause)', () => {
  const r = analyzeConfig(busy(100, 100, { shared_buffers: size(1024, true), work_mem: size(0.0625), autovacuum_max_workers: val('1', true) }),
    mem(512, false), today);   // J = 256
  memOnly(r, 256);
  assert.equal(rec(r, 'shared_buffers')?.suggested, '64MB');
  assert.equal(rec(r, 'work_mem'), undefined);
});
test('overflow from autovacuum_work_mem -> lowered to recommended maintenance_work_mem', () => {
  const r = analyzeConfig(busy(100, 50, { autovacuum_work_mem: size(1024), autovacuum_max_workers: val('10', true) }), mem(2048), today);
  memOnly(r, 2048);   // 128 + 400 + 10×1024 overflows; 10×102MB fits
  assert.equal(rec(r, 'autovacuum_work_mem')?.suggested, '102MB');
});
test('even min(current, R) overflows at used connections -> too-small verdict still fires', () => {
  const r = analyzeConfig(busy(500, 300, { work_mem: size(64) }), mem(1024), today);   // R′ fits 170, in use 300
  assert.equal(r.memory.tooSmall, true);
  assert.equal(r.memory.tooSmallReason, 'RAM terlalu kecil untuk jumlah koneksi yang sedang dipakai');
  assert.ok(!r.recs.some(x => MEM_PG.includes(x.setting)));
});
test('shrunk postgres increases round down to whole 8MB', () => {
  // J = 2010: shared_buffers 502MB would leave 2294MB; exact fit is 218MB, rounded down to 216MB
  const r = analyzeConfig(busy(400, 350, { shared_buffers: size(64, true) }), mem(4020, false), today);
  assert.equal(rec(r, 'shared_buffers')?.suggested, '216MB');
  assert.match(rec(r, 'shared_buffers')!.reason, /^Dibatasi/);
  assert.ok(r.memory.worstAfterMb! <= 2010);
});
