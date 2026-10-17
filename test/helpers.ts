import { SkipError } from '../src/types.js';
import type { DbAdapter } from '../src/types.js';

export function fakeAdapter(overrides: Partial<DbAdapter> = {}): DbAdapter {
  return {
    dialect: 'postgres', defaultSchema: 'public',
    info: async () => ({ dialect: 'postgres', flavor: 'postgres', version: '16.0', database: 'db', statsSince: null, warnings: [] }),
    statements: async () => [], explain: async () => [], tables: async () => [], indexes: async () => [],
    tableScans: async () => [], unindexedForeignKeys: async () => [], unusedIndexes: async () => [],
    longRunning: async () => [], lockWaits: async () => [],
    serverConfig: async () => { throw new SkipError('serverConfig tidak tersedia'); },
    describeError: err => (err as { code?: string })?.code === '42501' ? 'Beri role pg_read_all_stats' : null,
    close: async () => {},
    ...overrides,
  };
}

const MBYTES = 1048576;
export const pgFacts = (extra: Record<string, unknown> = {}, partial = false) => ({
  flavor: 'postgres' as const, version: '16.4',
  connections: { max: 100, reserved: 0, used: 5, partial, groups: [{ database: 'db', user: 'u', app: 'a', state: 'idle', count: 5, idleLong: 0 }] },
  pgStatStatements: { preloaded: true, created: true },
  settings: {
    shared_buffers: { value: String(128 * MBYTES), bytes: 128 * MBYTES, restart: true },
    effective_cache_size: { value: String(4096 * MBYTES), bytes: 4096 * MBYTES, restart: false },
    work_mem: { value: String(4 * MBYTES), bytes: 4 * MBYTES, restart: false },
    maintenance_work_mem: { value: String(64 * MBYTES), bytes: 64 * MBYTES, restart: false },
    autovacuum_work_mem: { value: '-1', restart: false }, autovacuum_max_workers: { value: '3', restart: true },
    max_connections: { value: '100', restart: true },
  },
  ...extra,
});
