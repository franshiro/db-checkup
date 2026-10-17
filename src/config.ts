export type Flavor = 'postgres' | 'mysql' | 'mariadb';
export interface Setting { value: string; bytes?: number; restart: boolean }   // bytes: memory sizes only, normalized
export interface ConnGroup { database?: string; user: string; app: string; state: string; count: number; idleLong: number }
export interface ServerFacts {
  flavor: Flavor; version: string; settings: Record<string, Setting>;
  connections: { max: number; reserved: number; used: number; peak?: number; rejected?: number; partial: boolean; groups: ConnGroup[] };
  pgStatStatements?: { preloaded: boolean; created: boolean }; digestConsumer?: boolean;
}
export interface ServerMemory { totalMb?: number; availableMb?: number; source: 'lokal' | 'manual' | 'flag' | null; dedicated: boolean }
export interface Rec { setting: string; current: string; suggested: string; reason: string; restart: boolean }
export interface ConfigResult {
  connections: ServerFacts['connections'] & { effective: number; usagePct: number; warn: boolean; advice: string[] };
  memory: { quotaMb?: number; totalMb?: number; availableMb?: number; source: ServerMemory['source']; dedicated: boolean;
            worstMb: number; worstAfterMb?: number; overflow: boolean; tooSmall?: boolean; skipped?: string };
  recs: Rec[];
  readiness: { item: string; ok: boolean; fix?: string; restart?: boolean }[];
  version: { major: string; eol?: string; status: 'eol' | 'segera' | 'ok' | 'unknown' };
  commands: { platform: 'Server sendiri' | 'AWS RDS' | 'Google Cloud SQL'; lines: string[] }[];
}

// Non-dynamic MySQL/MariaDB variables: my.cnf + restart, never SET.
export const MYSQL_STATIC: ReadonlySet<string> = new Set(['performance_schema', 'innodb_buffer_pool_instances', 'innodb_buffer_pool_chunk_size', 'thread_stack', 'aria_pagecache_buffer_size']);
// Fallback only; facts carry pg_settings.context.
const PG_STATIC = new Set(['shared_buffers', 'max_connections', 'shared_preload_libraries', 'track_activity_query_size']);
// End-of-life month per major version, data per 2026-10-17.
const EOL: Record<Flavor, Record<string, string>> = {
  postgres: { 12: '2024-11', 13: '2025-11', 14: '2026-11', 15: '2027-11', 16: '2028-11', 17: '2029-11', 18: '2030-11' },
  mysql: { '5.7': '2023-10', '8.0': '2026-04', '8.4': '2032-04' },
  mariadb: { '10.6': '2026-07', '10.11': '2028-02', '11.4': '2029-05' },
};
const MB = 1048576;
const PER_CONN = ['sort_buffer_size', 'join_buffer_size', 'read_buffer_size', 'read_rnd_buffer_size', 'thread_stack', 'binlog_cache_size'];
const PG_UNIT_KB: Record<string, number> = { shared_buffers: 8, effective_cache_size: 8 };   // RDS / Cloud SQL take pg base units
const REASON: Record<string, string> = {
  shared_buffers: '25% jatah RAM',
  effective_cache_size: '75% jatah RAM (perkiraan cache, tidak mengalokasikan memori)',
  work_mem: '(jatah RAM − shared_buffers) ÷ (max_connections × 3), minimal 4MB',
  maintenance_work_mem: '5% jatah RAM, 64MB–2GB',
  innodb_buffer_pool_size: '70% jatah RAM dikurangi buffer per koneksi; MySQL bisa membulatkan lagi ke kelipatan innodb_buffer_pool_chunk_size × innodb_buffer_pool_instances',
  max_connections: 'Nilai terbesar yang masih muat di jatah RAM; pakai connection pooler',
};
const fmt = new Intl.NumberFormat('id-ID');
const isOn = (v?: string) => /^(on|1|true|yes)$/i.test(v ?? '');
const floor128 = (mb: number) => Math.max(128, Math.floor(mb / 128) * 128);

export function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([mg])b?$/i.exec(s.trim());
  const mb = m ? Math.floor(Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 : 1)) : 0;
  return mb >= 1 ? mb : null;
}
export const formatSize = (mb: number) =>
  mb > 0 && mb % 1024 === 0 ? `${mb / 1024}GB` : Number.isInteger(mb) ? `${mb}MB` : `${Math.round(mb * 1024)}kB`;

interface Change { setting: string; value: string; restart: boolean; mb?: number; bool?: boolean; plain?: string }
type Vals = Record<string, number>;

export function analyzeConfig(f: ServerFacts, m: ServerMemory, today: Date): ConfigResult {
  const s = f.settings, isPg = f.flavor === 'postgres', c = f.connections, n = c.max;
  const mbOf = (k: string) => (s[k]?.bytes ?? 0) / MB;
  const changes: Change[] = [], recs: Rec[] = [], advice = new Set<string>();
  const readiness: ConfigResult['readiness'] = [];
  const change = (ch: Omit<Change, 'restart'>) => {
    const restart = s[ch.setting]?.restart ?? (isPg ? PG_STATIC : MYSQL_STATIC).has(ch.setting);
    changes.push({ ...ch, restart });
    return restart;
  };
  const rec = (ch: Omit<Change, 'restart'>, current: string, reason: string) =>
    recs.push({ setting: ch.setting, current, suggested: ch.value, reason, restart: change(ch) });
  const pooler = isPg ? 'Pasang connection pooler (PgBouncer, mode transaction) dan kurangi pool koneksi aplikasi.'
                      : 'Pakai connection pooler (mis. ProxySQL) dan kurangi pool koneksi aplikasi.';

  // Memory model. worst() is linear in max_connections, which maxConn() relies on.
  const avw = Number(s.autovacuum_max_workers?.value ?? 3), av = s.autovacuum_work_mem;
  const avwm = av && av.value !== '-1' && (av.bytes ?? 0) > 0 ? av.bytes! / MB : -1;
  const fixedMy = mbOf('key_buffer_size') + (f.flavor === 'mariadb' ? mbOf('aria_pagecache_buffer_size') : 0);
  const perConn = PER_CONN.reduce((a, k) => a + mbOf(k), 0);
  const worst = (v: Vals) => isPg
    ? v.shared_buffers + v.max_connections * v.work_mem + avw * (avwm < 0 ? v.maintenance_work_mem : avwm)
    : v.innodb_buffer_pool_size + fixedMy + v.max_connections * perConn;
  const maxConn = (v: Vals, J: number) => {
    const base = worst({ ...v, max_connections: 0 });
    return Math.floor((J - base) / (worst({ ...v, max_connections: 1 }) - base) / 10) * 10;
  };
  const cur: Vals = isPg
    ? { shared_buffers: mbOf('shared_buffers'), effective_cache_size: mbOf('effective_cache_size'), work_mem: mbOf('work_mem'),
        maintenance_work_mem: mbOf('maintenance_work_mem'), max_connections: n }
    : { innodb_buffer_pool_size: mbOf('innodb_buffer_pool_size'), max_connections: n };
  const J = m.totalMb ? Math.floor(m.totalMb * (m.dedicated ? 1 : 0.5)) : undefined;
  const memory: ConfigResult['memory'] = { quotaMb: J, totalMb: m.totalMb, availableMb: m.availableMb, source: m.source, dedicated: m.dedicated,
    worstMb: Math.floor(worst(cur)), overflow: J !== undefined && worst(cur) > J };
  let final: Vals | undefined;

  if (J === undefined) memory.skipped = 'RAM server tidak diketahui, pakai --ram';
  else {
    const sb = Math.floor(J * 0.25);
    const R: Vals = isPg
      ? { shared_buffers: sb, effective_cache_size: Math.floor(J * 0.75), work_mem: Math.max(4, Math.floor((J - sb) / (Math.max(n, 1) * 3))),
          maintenance_work_mem: Math.min(2048, Math.max(64, Math.floor(J * 0.05))), max_connections: n }
      : { innodb_buffer_pool_size: floor128(Math.floor(J * 0.7) - n * perConn), max_connections: n };
    const knob = isPg ? 'work_mem' : 'innodb_buffer_pool_size', changed = new Set<string>();
    if (worst(R) > J) {   // step 2: shrink the per-query / pool knob, not below its floor
      const room = J - worst({ ...R, [knob]: 0 });
      const fit = isPg ? Math.max(4, Math.floor(room / Math.max(n, 1))) : floor128(room);
      if (fit < R[knob]) { R[knob] = fit; changed.add(knob); }
    }
    if (worst(R) > J) {   // step 3: knob is at its floor, cut connections
      const nc = maxConn(R, J);
      if (nc < 20) memory.tooSmall = true;
      else { R.max_connections = nc; changed.add('max_connections'); advice.add(pooler); }
    }
    if (!memory.tooSmall) {
      const off = (k: string) => cur[k] < R[k] * 0.5 || cur[k] > R[k] * 1.5;
      const apply = (ks: string[]): Vals => ({ ...cur, ...Object.fromEntries(ks.map(k => [k, R[k]])) });
      let shown = Object.keys(R).filter(k => (k !== 'max_connections' && off(k)) || (changed.has(k) && memory.overflow));
      // Applying only some values can still overflow (e.g. raising a tiny work_mem); R itself fits by construction.
      if (worst(apply(shown)) > J) shown = Object.keys(R).filter(k => R[k] !== cur[k]);
      final = apply(shown);
      memory.worstAfterMb = Math.floor(worst(final));
      for (const k of shown) {
        const conn = k === 'max_connections';
        rec({ setting: k, value: conn ? String(R[k]) : formatSize(R[k]), mb: conn ? undefined : R[k] },
          conn ? String(cur[k]) : formatSize(cur[k]),
          changed.has(k) && !conn ? 'Diturunkan supaya perkiraan memori terburuk muat di jatah RAM' : REASON[k]);
      }
    }
  }

  const effective = c.max - c.reserved;
  const warn = Math.max(c.used, c.peak ?? 0) >= effective * 0.8;
  if (warn) {
    advice.add(pooler);
    const safe = J !== undefined && final ? maxConn(final, J) : NaN;
    advice.add(J === undefined ? 'Jangan menaikkan max_connections sebelum memori dihitung (pakai --ram).'
      : Number.isFinite(safe) && safe > n ? `max_connections bisa dinaikkan sampai ${fmt.format(safe)} tanpa melebihi jatah RAM (dengan setting yang disarankan).`
      : 'Jangan menaikkan max_connections: memori tidak cukup.');
  }
  if (c.rejected) advice.add(`${fmt.format(c.rejected)} kali koneksi ditolak karena max_connections penuh (sejak server restart).`);
  const idle = (state: string) => c.groups.filter(g => g.state === state).reduce((a, g) => a + g.idleLong, 0);
  const idleTx = isPg ? idle('idle in transaction') : 0, sleep = isPg ? 0 : idle('Sleep');
  if (idleTx) rec({ setting: 'idle_in_transaction_session_timeout', value: '60s', plain: '60000' }, s.idle_in_transaction_session_timeout?.value ?? '-',
    `${fmt.format(idleTx)} koneksi idle in transaction lebih dari 1 menit (menahan lock)`);
  if (sleep) for (const k of ['wait_timeout', 'interactive_timeout'])
    rec({ setting: k, value: '600' }, s[k]?.value ?? '-', `${fmt.format(sleep)} koneksi Sleep lebih dari 10 menit`);

  const ready = (item: string, ok: boolean, fix: string, chs: Omit<Change, 'restart'>[] = []) => {
    if (ok) return readiness.push({ item, ok });
    readiness.push({ item, ok, fix, restart: chs.map(change).some(Boolean) });
  };
  if (isPg) {
    const libs = (s.shared_preload_libraries?.value ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const p = f.pgStatStatements ?? { preloaded: libs.includes('pg_stat_statements'), created: false };
    ready('pg_stat_statements', p.preloaded && p.created, p.preloaded ? 'Jalankan CREATE EXTENSION pg_stat_statements;'
      : 'Tambahkan pg_stat_statements ke shared_preload_libraries (perlu restart), lalu jalankan CREATE EXTENSION pg_stat_statements;',
      p.preloaded ? [] : [{ setting: 'shared_preload_libraries', value: [...libs, 'pg_stat_statements'].join(',') }]);
    ready('track_io_timing = on', isOn(s.track_io_timing?.value), 'Set track_io_timing = on (cukup reload).',
      [{ setting: 'track_io_timing', value: 'on', bool: true }]);
    ready('track_activity_query_size ≥ 4096', Number(s.track_activity_query_size?.value) >= 4096,
      'Set track_activity_query_size = 4096 supaya teks query tidak terpotong.', [{ setting: 'track_activity_query_size', value: '4096' }]);
    const lmd = s.log_min_duration_statement?.value;
    ready('log_min_duration_statement (log query lambat)', lmd !== undefined && lmd !== '-1',
      'Set log_min_duration_statement = 1000 (ms) untuk mencatat query lambat.', [{ setting: 'log_min_duration_statement', value: '1000' }]);
  } else {
    const ps = isOn(s.performance_schema?.value);
    ready('performance_schema = ON', ps, 'Tambahkan performance_schema = ON di my.cnf bagian [mysqld], lalu restart.',
      [{ setting: 'performance_schema', value: 'ON', bool: true }]);
    ready('consumer statements_digest', f.digestConsumer === true, `${ps ? '' : 'Setelah performance_schema aktif: '}jalankan UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = 'statements_digest'; dan tambahkan performance-schema-consumer-statements-digest = ON di my.cnf [mysqld].`);
    ready('slow_query_log = ON', isOn(s.slow_query_log?.value), 'Set slow_query_log = ON dengan long_query_time = 1 (detik).',
      [{ setting: 'slow_query_log', value: 'ON', bool: true }, { setting: 'long_query_time', value: '1' }]);
  }

  const parts = f.version.split('.');
  const major = isPg && Number(parts[0]) >= 10 ? parts[0] : parts.slice(0, 2).join('.');
  const eol = EOL[f.flavor][major];
  let version: ConfigResult['version'] = { major, status: 'unknown' };
  if (eol) {
    const [y, mo] = eol.split('-').map(Number);
    version = { major, eol, status: today >= new Date(y, mo - 1, 1) ? 'eol' : today >= new Date(y, mo - 7, 1) ? 'segera' : 'ok' };
  }

  return { connections: { ...c, effective, usagePct: effective > 0 ? Math.round(c.used / effective * 100) : 0, warn, advice: [...advice] },
           memory, recs, readiness, version, commands: commands(f, changes) };
}

function commands(f: ServerFacts, changes: Change[]): ConfigResult['commands'] {
  if (!changes.length) return [];
  const isPg = f.flavor === 'postgres', restart = changes.filter(c => c.restart).map(c => c.setting).join(', ');
  const cloud = (rds: boolean) => changes.flatMap(c => {
    if (c.bool) return [`${c.setting} = ${rds ? '1' : 'on'}`];
    if (c.mb === undefined) return !rds && c.setting === 'shared_preload_libraries' ? ['# pg_stat_statements: cukup CREATE EXTENSION pg_stat_statements'] : [`${c.setting} = ${c.plain ?? c.value}`];
    if (!isPg) return [`${c.setting} = ${c.mb * MB}`];
    const unit = PG_UNIT_KB[c.setting] ?? 1;
    return [`# ${c.setting} ${formatSize(c.mb)} dalam satuan ${unit}kB:`, `${c.setting} = ${c.mb * 1024 / unit}`];
  });
  let self: string[];
  if (isPg) {
    // list GUCs need one literal per item; 'a,b' would be read as a single library name
    const lit = (c: Change) => c.setting === 'shared_preload_libraries' ? c.value.split(',').map(x => `'${x}'`).join(', ') : `'${c.value}'`;
    self = ['-- ALTER SYSTEM butuh superuser (PG15+: atau GRANT ALTER SYSTEM ON PARAMETER)',
      ...changes.map(c => `ALTER SYSTEM SET ${c.setting} = ${lit(c)};`), 'SELECT pg_reload_conf();'];
  } else {
    const verb = f.flavor === 'mysql' && Number(f.version.split('.')[0]) >= 8 ? 'PERSIST' : 'GLOBAL';
    const v = (c: Change, cnf: boolean) => c.bool ? 'ON' : c.mb === undefined ? c.value
      : !cnf ? String(c.mb * MB) : c.mb % 1024 === 0 ? `${c.mb / 1024}G` : `${c.mb}M`;
    self = [...changes.filter(c => !MYSQL_STATIC.has(c.setting)).map(c => `SET ${verb} ${c.setting} = ${v(c, false)};`),
      '-- my.cnf, supaya bertahan setelah restart:', '[mysqld]', ...changes.map(c => `${c.setting} = ${v(c, true)}`)];
  }
  if (restart) self.push(`-- Perlu restart server untuk: ${restart}`);
  return [
    { platform: 'Server sendiri', lines: self },
    { platform: 'AWS RDS', lines: ['# Ubah di parameter group', ...cloud(true), ...(restart ? [`# Perlu reboot untuk: ${restart}`] : [])] },
    { platform: 'Google Cloud SQL', lines: ['# Ubah di database flags', ...cloud(false), ...(restart ? [`# Perlu restart instance untuk: ${restart}`] : [])] },
  ];
}
