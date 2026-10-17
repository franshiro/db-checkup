import type { ConfigResult, ServerFacts } from './config.js';
export type Dialect = 'postgres' | 'mysql';
export const MIN_TABLE_ROWS = 10000, LONG_RUNNING_SECONDS = 5, DEFAULT_TOP = 10, QUERY_PREVIEW_CHARS = 200;
export interface ServerInfo { dialect: Dialect; flavor: 'postgres' | 'mysql' | 'mariadb'; version: string; database: string; statsSince: Date | null; warnings: string[] }
export interface StatementStat { key: string; query: string; sample?: string; calls: number; totalMs: number; meanMs: number; rows: number; rowsExamined?: number; noIndexUsed?: number }
export interface TableInfo { table: string; rows: number; columns: string[] }          // table = 'schema.name'
export interface IndexInfo { table: string; name: string; columns: string[]; unique: boolean; primary: boolean }
export interface PlanScan { table: string }                                             // 'schema.name', or alias/bare name (MySQL)
export interface ColumnUsage { table: string; column: string; kind: 'eq' | 'range' | 'order' }
export type Confidence = 'tinggi' | 'sedang' | 'rendah';
export interface Suggestion { query: string; table: string; columns: string[]; confidence: Confidence; reason: string; sql: string }
export interface SuggestionResult { items: Suggestion[]; skipped: { query: string; reason: string }[] }
export interface TableScanStat { table: string; scans?: number; rowsRead: number; liveRows?: number }
export interface ForeignKeyIssue { table: string; constraint: string; columns: string[] }
export interface RunningQuery { pid: number; user: string; seconds: number; state: string; query: string }
export interface LockWait { waitingPid: number; waitingQuery: string; blockingPid: number; blockingQuery: string | null; seconds: number }
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };
export class SkipError extends Error {}   // "not enabled / not supported": message shown verbatim, never masked
export interface DbAdapter {
  dialect: Dialect; defaultSchema: string;
  info(): Promise<ServerInfo>;
  statements(): Promise<StatementStat[]>;
  explain(stmt: StatementStat): Promise<PlanScan[]>;
  tables(): Promise<TableInfo[]>;
  indexes(): Promise<IndexInfo[]>;
  tableScans(limit: number): Promise<TableScanStat[]>;
  unindexedForeignKeys(): Promise<ForeignKeyIssue[]>;
  unusedIndexes(limit: number): Promise<IndexInfo[]>;
  longRunning(minSeconds: number): Promise<RunningQuery[]>;
  lockWaits(): Promise<LockWait[]>;
  serverConfig(): Promise<ServerFacts>;
  describeError(err: unknown): string | null;   // privilege hint for access-denied errors
  close(): Promise<void>;
}
export type AnalysisPart = 'statements' | 'suggestions' | 'tableScans' | 'foreignKeys' | 'unusedIndexes' | 'running' | 'locks' | 'config';
export interface AnalysisResult {
  connection: string; info: ServerInfo; watchSeconds?: number;
  current?: Outcome<StatementStat[]>; cumulative?: Outcome<StatementStat[]>;
  suggestions?: Outcome<SuggestionResult>;
  tableScans?: Outcome<TableScanStat[]>; foreignKeys?: Outcome<ForeignKeyIssue[]>; unusedIndexes?: Outcome<IndexInfo[]>;
  running?: Outcome<RunningQuery[]>; locks?: Outcome<LockWait[]>; config?: Outcome<ConfigResult>;
}
