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
