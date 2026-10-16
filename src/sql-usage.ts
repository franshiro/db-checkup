import pkg from 'node-sql-parser';
import type { ColumnUsage, Dialect, TableInfo } from './types.js';

export class SqlParseError extends Error {}

const EQ = new Set(['=', 'IN']);
const RANGE = new Set(['<', '>', '<=', '>=', 'BETWEEN', 'LIKE']);

export function normalizeDigest(digest: string): string {
  return digest.replace(/\bIN\s*\(\s*\.\.\.\s*\)/gi, 'IN (?)');
}

// AST nodes come from node-sql-parser and are loosely typed.
const colName = (c: any): string => String(typeof c.column === 'string' ? c.column : c.column?.expr?.value ?? '');

export function extractColumnUsage(sql: string, dialect: Dialect, defaultSchema: string, tables: TableInfo[]):
  { aliases: Record<string, string>; usage: ColumnUsage[] } {
  let ast: any;
  try {
    ast = new pkg.Parser().astify(sql, { database: dialect === 'postgres' ? 'PostgresQL' : 'MySQL' });
  } catch (e) {
    throw new SqlParseError(e instanceof Error ? e.message : String(e));
  }
  if (Array.isArray(ast)) ast = ast[0];
  if (!ast) throw new SqlParseError('empty statement');

  // SELECT: from[]; UPDATE: table[]; DELETE: from[] (table[] only repeats it)
  const refs: any[] = (ast.type === 'update' ? ast.table : ast.from) ?? [];
  const aliases: Record<string, string> = {};
  const scope: TableInfo[] = [];     // tables in FROM, in order
  for (const r of refs) {
    if (typeof r.table !== 'string') continue;   // subquery etc.
    const key = `${r.db ?? defaultSchema}.${r.table}`.toLowerCase();
    const info = tables.find(t => t.table.toLowerCase() === key) ?? { table: key, rows: 0, columns: [] };
    scope.push(info);
    aliases[r.table.toLowerCase()] = info.table;
    if (r.as) aliases[String(r.as).toLowerCase()] = info.table;
  }

  const add = (out: ColumnUsage[], c: any, kind: ColumnUsage['kind']) => {
    if (c?.type !== 'column_ref') return;
    const name = colName(c), lower = name.toLowerCase();
    let table: string | undefined;
    if (c.table) table = aliases[String(c.table.value ?? c.table).toLowerCase()];   // backtick-quoted qualifier is {type, value}
    else {
      const hits = scope.filter(t => t.columns.some(x => x.toLowerCase() === lower));
      if (hits.length === 1) table = hits[0].table;
    }
    if (!table || !name || name === '*') return;
    const column = tables.find(t => t.table === table)?.columns.find(x => x.toLowerCase() === lower) ?? lower;
    if (!out.some(u => u.table === table && u.column === column && u.kind === kind)) out.push({ table, column, kind });
  };
  const walk = (e: any, out: ColumnUsage[]) => {
    if (e?.type !== 'binary_expr') return;
    const op = String(e.operator).toUpperCase();
    if (op === 'AND') { walk(e.left, out); walk(e.right, out); }
    else if (op === 'OR') {   // only usages common to every branch can back one index
      const l: ColumnUsage[] = [], r: ColumnUsage[] = [];
      walk(e.left, l); walk(e.right, r);
      for (const u of l) if (r.some(v => v.table === u.table && v.column === u.column && v.kind === u.kind)) out.push(u);
    }
    else if (EQ.has(op)) { add(out, e.left, 'eq'); add(out, e.right, 'eq'); }   // right is a column only in join conditions
    else if (RANGE.has(op)) add(out, e.left, 'range');
  };

  const usage: ColumnUsage[] = [];
  for (const r of refs) walk(r.on, usage);
  walk(ast.where, usage);
  for (const o of ast.orderby ?? []) add(usage, o.expr, 'order');
  return { aliases, usage };
}
