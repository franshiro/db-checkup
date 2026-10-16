import { extractColumnUsage } from './sql-usage.js';
import { MIN_TABLE_ROWS, type ColumnUsage, type Dialect, type IndexInfo, type PlanScan, type Suggestion, type TableInfo } from './types.js';

// ponytail: small reserved list, extend when a real name breaks
const RESERVED = new Set('order group user key index table select from where desc asc limit range rank check default references to window'.split(' '));
const fmt = new Intl.NumberFormat('id-ID');
const lc = (s: string) => s.toLowerCase();
const split = (t: string): [string, string] => { const i = t.indexOf('.'); return [t.slice(0, i), t.slice(i + 1)]; };

const quote = (d: Dialect, n: string) =>
  (d === 'postgres' ? /^[a-z_][a-z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(n) && !RESERVED.has(lc(n)) ? n
    : d === 'postgres' ? `"${n.replace(/"/g, '""')}"` : `\`${n.replace(/`/g, '``')}\``;

export function indexName(table: string, columns: string[]): string {
  return `idx_${split(table)[1]}_${columns.join('_')}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
}

export function createIndexSql(dialect: Dialect, table: string, columns: string[], defaultSchema: string): string {
  const [schema, name] = split(table);
  const target = (schema === defaultSchema ? '' : `${quote(dialect, schema)}.`) + quote(dialect, name);
  const cols = columns.map(c => quote(dialect, c)).join(', ');
  return dialect === 'postgres'
    ? `CREATE INDEX CONCURRENTLY ${indexName(table, columns)} ON ${target} (${cols});`
    : `CREATE INDEX ${indexName(table, columns)} ON ${target} (${cols}) ALGORITHM=INPLACE, LOCK=NONE;`;
}

export function suggestIndexes(input: { query: string; dialect: Dialect; defaultSchema: string; scans: PlanScan[] | null; noPlanReason?: string;
                                        tables: TableInfo[]; indexes: IndexInfo[] }): Omit<Suggestion, 'query'>[] {
  const { dialect, defaultSchema, scans, tables, indexes } = input;
  const { aliases, usage } = extractColumnUsage(input.query, dialect, defaultSchema, tables);
  const candidates = scans
    ? scans.map(s => aliases[lc(s.table)] ?? (s.table.includes('.') ? s.table : `${defaultSchema}.${s.table}`))
    : usage.map(u => u.table);
  const out: Omit<Suggestion, 'query'>[] = [];
  for (const key of new Set(candidates.map(lc))) {
    const info = tables.find(t => lc(t.table) === key);
    if (!info || info.rows <= MIN_TABLE_ROWS) continue;
    const mine = usage.filter(u => lc(u.table) === key);
    const of = (k: ColumnUsage['kind']) => mine.filter(u => u.kind === k).map(u => u.column);
    const columns: string[] = [];
    for (const c of [...of('eq'), ...of('range').slice(0, 1), ...of('order')]) {
      if (!columns.some(x => lc(x) === lc(c))) columns.push(c);
    }
    if (!columns.length) continue;
    const covered = indexes.some(i => lc(i.table) === key && columns.length <= i.columns.length && columns.every((c, n) => lc(c) === lc(i.columns[n])));
    if (covered) continue;
    const [, name] = split(info.table);
    const rows = fmt.format(info.rows), cols = columns.join(', ');
    out.push({
      table: info.table, columns, sql: createIndexSql(dialect, info.table, columns, defaultSchema),
      confidence: !scans ? 'rendah' : of('eq').length ? 'tinggi' : 'sedang',
      reason: scans
        ? `${dialect === 'postgres' ? 'Seq Scan' : 'Full table scan'} pada \`${name}\` (${rows} baris), filter \`${cols}\``
        : `Tanpa rencana eksekusi (${input.noPlanReason}); tabel \`${name}\` ${rows} baris, kolom \`${cols}\``,
    });
  }
  return out;
}
