import { maskSql } from './mask.js';
import { LONG_RUNNING_SECONDS, QUERY_PREVIEW_CHARS } from './types.js';
import type { AnalysisResult, Outcome, StatementStat } from './types.js';

export type Block = { kind: 'table'; headers: string[]; rows: string[][] } | { kind: 'code'; text: string } | { kind: 'text'; text: string; level?: 'info' | 'warn' };
export interface Section { title: string; blocks: Block[] }
export interface Report { title: string; sections: Section[] }

const nf = new Intl.NumberFormat('id-ID');
const nf1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
export const formatCount = (n: number) => nf.format(n);
export const formatMs = (ms: number) =>
  ms < 1000 ? `${nf.format(Math.round(ms))} ms` : ms < 60000 ? `${nf1.format(ms / 1000)} s` : `${nf1.format(ms / 60000)} min`;

export function buildReport(r: AnalysisResult, opts: { mask: boolean }): Report {
  const preview = (q: string) => {
    const s = (opts.mask ? maskSql(q, r.info.dialect) : q).replace(/\s+/g, ' ').trim();
    return s.length > QUERY_PREVIEW_CHARS ? s.slice(0, QUERY_PREVIEW_CHARS) + '…' : s;
  };
  const empty: Block = { kind: 'text', text: 'Tidak ada temuan.' };
  // Failed outcome -> "Dilewati" text; empty -> "Tidak ada temuan."; else the blocks.
  const skippedLines: Block[] = [];
  const section = <T>(title: string, o: Outcome<T>, build: (v: T) => Block[] | null): Section => {
    if (!o.ok) skippedLines.push({ kind: 'text', text: `Dilewati — ${title}: ${o.reason}`, level: 'warn' });
    return { title, blocks: !o.ok ? [{ kind: 'text', text: `Dilewati: ${o.reason}` }] : build(o.value) ?? [empty] };
  };
  const list = <T>(title: string, o: Outcome<T[]>, headers: string[], row: (x: T, i: number) => string[]) =>
    section(title, o, v => v.length ? [{ kind: 'table', headers, rows: v.map(row) }] : null);

  const statements = (title: string, o: Outcome<StatementStat[]>) => section(title, o, v => {
    if (!v.length) return null;
    const my = v.some(s => s.rowsExamined !== undefined || s.noIndexUsed !== undefined);
    return [{
      kind: 'table', headers: ['#', 'Query', 'Eksekusi', 'Total', 'Rata-rata', 'Baris', ...(my ? ['Baris diperiksa', 'Tanpa index'] : [])],
      rows: v.map((s, i) => [String(i + 1), preview(s.query), formatCount(s.calls), formatMs(s.totalMs), formatMs(s.meanMs), formatCount(s.rows),
        ...(my ? [formatCount(s.rowsExamined ?? 0), formatCount(s.noIndexUsed ?? 0)] : [])]),
    }];
  });

  const sections: Section[] = [];
  if (r.current) sections.push(statements(`Query terberat saat ini (${r.watchSeconds} detik terakhir)`, r.current));
  sections.push(statements('Query paling lambat (akumulasi)', r.cumulative));
  sections.push(section('Saran index', r.suggestions, ({ items, skipped }) => {
    const blocks: Block[] = [];
    if (items.length) blocks.push(
      { kind: 'table', headers: ['Query', 'Tabel', 'Kolom', 'Keyakinan', 'Alasan'], rows: items.map(s => [preview(s.query), s.table, s.columns.join(', '), s.confidence, s.reason]) },
      { kind: 'code', text: items.map(s => s.sql).join('\n') },
      { kind: 'text', text: 'Uji index di staging dulu. Setiap index menambah beban INSERT dan UPDATE.', level: 'warn' });
    for (const s of skipped) blocks.push({ kind: 'text', text: `Dilewati: ${preview(s.query)} — ${s.reason}` });
    return blocks.length ? blocks : null;
  }));
  sections.push(list('Tabel yang sering di-scan penuh', r.tableScans, ['Tabel', 'Scan', 'Baris dibaca', 'Baris live'],
    t => [t.table, t.scans === undefined ? '-' : formatCount(t.scans), formatCount(t.rowsRead), t.liveRows === undefined ? '-' : formatCount(t.liveRows)]));
  sections.push(list('Foreign key tanpa index', r.foreignKeys, ['Tabel', 'Constraint', 'Kolom'], f => [f.table, f.constraint, f.columns.join(', ')]));
  sections.push(list('Index yang tidak pernah dipakai', r.unusedIndexes, ['Tabel', 'Index', 'Kolom'], i => [i.table, i.name, i.columns.join(', ')]));
  sections.push(list(`Query yang sedang jalan lama (> ${LONG_RUNNING_SECONDS} detik)`, r.running, ['PID', 'User', 'Detik', 'Status', 'Query'],
    q => [String(q.pid), q.user, formatCount(Math.round(q.seconds)), q.state, preview(q.query)]));
  sections.push(list('Query yang saling mengunci', r.locks, ['PID menunggu', 'Query menunggu', 'PID pengunci', 'Query pengunci', 'Detik'],
    l => [String(l.waitingPid), preview(l.waitingQuery), String(l.blockingPid), l.blockingQuery === null ? '-' : preview(l.blockingQuery), formatCount(Math.round(l.seconds))]));

  const i = r.info;
  const summary: Block[] = [
    { kind: 'table', headers: ['Item', 'Nilai'], rows: [
      ['Database', `${i.flavor} ${i.version}`], ['Nama database', i.database], ['Koneksi', r.connection],
      ['Waktu analisa', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
      ['Statistik dikumpulkan sejak', i.statsSince ? i.statsSince.toISOString().slice(0, 10) : 'tidak diketahui']] },
    ...i.warnings.map((text): Block => ({ kind: 'text', text, level: 'warn' })),
    ...skippedLines,
  ];
  return { title: 'Laporan db-checkup', sections: [{ title: 'Ringkasan', blocks: summary }, ...sections] };
}
