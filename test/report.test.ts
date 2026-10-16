import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatMs, formatCount, type Report } from '../src/report.js';
import { renderMarkdown, renderTerminal } from '../src/render.js';
import type { AnalysisResult } from '../src/types.js';

const ok = { ok: true as const, value: [] };
function sampleResult(o: Partial<AnalysisResult>): AnalysisResult {
  return {
    connection: 'postgres://app:***@h/shop',
    info: { dialect: 'postgres', flavor: 'postgres', version: '16.4', database: 'shop', statsSince: new Date('2026-10-01'), warnings: [] },
    cumulative: ok, suggestions: { ok: true, value: { items: [], skipped: [] } },
    tableScans: ok, foreignKeys: ok, unusedIndexes: ok, running: ok, locks: ok, ...o,
  };
}
const titles = (r: Report) => r.sections.map(s => s.title);
test('section order with --watch', () =>
  assert.deepEqual(titles(buildReport(sampleResult({ watchSeconds: 60, current: { ok: true, value: [] } }), { mask: true })), [
    'Ringkasan', 'Query terberat saat ini (60 detik terakhir)', 'Query paling lambat (akumulasi)', 'Saran index',
    'Tabel yang sering di-scan penuh', 'Foreign key tanpa index', 'Index yang tidak pernah dipakai',
    'Query yang sedang jalan lama (> 5 detik)', 'Query yang saling mengunci']));
test('no current section without --watch', () =>
  assert.ok(!titles(buildReport(sampleResult({}), { mask: true })).some(t => t.startsWith('Query terberat saat ini'))));
test('empty section says Tidak ada temuan.', () =>
  assert.match(renderMarkdown(buildReport(sampleResult({}), { mask: true })), /## Index yang tidak pernah dipakai\n\nTidak ada temuan\./));
test('skipped outcome listed in Ringkasan and in its section', () => {
  const md = renderMarkdown(buildReport(sampleResult({ locks: { ok: false, reason: 'schema sys tidak tersedia' } }), { mask: true }));
  assert.match(md, /Dilewati — Query yang saling mengunci: schema sys tidak tersedia/);
  assert.match(md, /## Query yang saling mengunci\n\nDilewati: schema sys tidak tersedia/);
});
test('masking on all query text, off with mask:false', () => {
  const running = { ok: true as const, value: [{ pid: 1, user: 'app', seconds: 9, state: 'active', query: "SELECT * FROM u WHERE email = 'budi@x.com'" }] };
  assert.ok(!renderMarkdown(buildReport(sampleResult({ running }), { mask: true })).includes('budi@x.com'));
  assert.ok(renderMarkdown(buildReport(sampleResult({ running }), { mask: false })).includes('budi@x.com'));
});
test('masking covers locks, suggestions and skipped; reasons stay verbatim', () => {
  const q = "SELECT * FROM u WHERE email = 'budi@x.com'";
  const locks = { ok: true as const, value: [{ waitingPid: 1, waitingQuery: q, blockingPid: 2, blockingQuery: q, seconds: 3 }] };
  const suggestions = { ok: true as const, value: { items: [], skipped: [{ query: q, reason: "set shared_preload_libraries = 'pg_stat_statements'" }] } };
  const md = renderMarkdown(buildReport(sampleResult({ locks, suggestions, cumulative: { ok: false, reason: "shared_preload_libraries = 'pg_stat_statements'" } }), { mask: true }));
  assert.ok(!md.includes('budi@x.com'));
  assert.ok(md.includes("shared_preload_libraries = 'pg_stat_statements'"));
});
test('markdown cells escape pipes and newlines', () => {
  const cumulative = { ok: true as const, value: [{ key: 'k', query: 'SELECT a || b\nFROM t', calls: 1, totalMs: 1, meanMs: 1, rows: 1 }] };
  assert.ok(renderMarkdown(buildReport(sampleResult({ cumulative }), { mask: true })).includes('SELECT a \\|\\| b FROM t'));
});
test('suggestion sql in code block + staging reminder', () => {
  const suggestions = { ok: true as const, value: { skipped: [], items: [{ query: 'SELECT 1', table: 'public.orders', columns: ['customer_id'], confidence: 'tinggi' as const, reason: 'r', sql: 'CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders (customer_id);' }] } };
  const md = renderMarkdown(buildReport(sampleResult({ suggestions }), { mask: true }));
  assert.match(md, /```sql\nCREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders \(customer_id\);\n```/);
  assert.match(md, /Uji index di staging dulu\. Setiap index menambah beban INSERT dan UPDATE\./);
});
test('no ANSI in markdown or uncolored terminal; ANSI when colored', () => {
  const rep = buildReport(sampleResult({ locks: { ok: false, reason: 'x' } }), { mask: true });
  assert.ok(!/\x1b\[/.test(renderMarkdown(rep)));
  assert.ok(!/\x1b\[/.test(renderTerminal(rep, { color: false })));
  assert.ok(/\x1b\[/.test(renderTerminal(rep, { color: true })));
});
test('formatting', () => {
  assert.equal(formatMs(850), '850 ms'); assert.equal(formatMs(12345), '12,3 s'); assert.equal(formatMs(312000), '5,2 min');
  assert.equal(formatCount(2100000), '2.100.000');
});
