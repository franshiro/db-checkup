import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConnectionUrl, redactUrl } from './connection.js';
import type { ConnectionConfig } from './connection.js';
import { defaultName, envCandidates, parseEnv } from './dotenv.js';
import type { EnvCandidate } from './dotenv.js';
import { connectionUrl, loadConnections, removeConnection, saveConnection } from './store.js';
import type { SavedConnection } from './store.js';
import { analyze } from './analyze.js';
import { buildReport } from './report.js';
import type { Report } from './report.js';
import { renderMarkdown, renderTerminal } from './render.js';
import { DEFAULT_TOP } from './types.js';
import type { AnalysisPart, AnalysisResult, DbAdapter, ServerInfo } from './types.js';
import { ask, confirm, logo, select } from './tui.js';
import type { Term } from './tui.js';
import { DEFAULTS, addFromEnv, addManual } from './add.js';
import { redact } from './cli.js';
import { parseSize } from './config.js';
import type { ServerMemory } from './config.js';
import { hostOf, isLocalHost, localMemory } from './sysmem.js';

export interface MenuDeps {
  term: Term; env: Record<string, string | undefined>; cwd: string; storePath: string; version: string;
  createAdapter(c: ConnectionConfig): Promise<DbAdapter>;
  now(): Date;
  onInterrupt(cb: () => void): () => void;
  memory?: typeof localMemory;
}

// `from` set = not saved (row from .env or env DATABASE_URL); conn is then an EnvCandidate.
interface Row { name: string; from?: string; url?: string; conn: SavedConnection | EnvCandidate }

const CHOICES: { label: string; parts?: AnalysisPart[]; watch?: true }[] = [
  { label: 'Laporan lengkap' },
  { label: 'Query paling lambat', parts: ['statements'] },
  { label: 'Saran index', parts: ['suggestions'] },
  { label: 'Kondisi sekarang', parts: ['running', 'locks'] },
  { label: 'Pantau perubahan', parts: ['statements', 'suggestions'], watch: true },
  { label: 'Kesehatan index', parts: ['tableScans', 'foreignKeys', 'unusedIndexes'] },
  { label: 'Konfigurasi server', parts: ['config'] },
];

const msg = (err: unknown) => (err as Error)?.message ?? String(err);
const key = (c: Row['conn']) => JSON.stringify([c.host, c.port, c.user, c.database]);
const exists = (p: string) => access(p).then(() => true, () => false);
const p2 = (n: number) => String(n).padStart(2, '0');
const stamp = (n: Date) => `${n.getFullYear()}${p2(n.getMonth() + 1)}${p2(n.getDate())}-${p2(n.getHours())}${p2(n.getMinutes())}`;

// Unsaved connections from env DATABASE_URL and ./.env (same host, port, user, database as a saved one: hidden).
async function envRows(d: MenuDeps, saved: SavedConnection[]): Promise<Row[]> {
  const known = new Set(saved.map(key));
  const rows: Row[] = [];
  const add = (from: string, name: string, c: EnvCandidate, url?: string) => {
    if (known.has(key(c))) return;
    known.add(key(c));
    rows.push({ name, from, url, conn: c });
  };
  if (d.env.DATABASE_URL) for (const c of envCandidates({ DATABASE_URL: d.env.DATABASE_URL })) add('dari env DATABASE_URL', 'database-url', c, d.env.DATABASE_URL);
  const path = join(d.cwd, '.env');
  let text = '';
  try { text = await readFile(path, 'utf8'); } catch { /* tidak ada .env */ }
  for (const c of envCandidates(parseEnv(text))) add('dari .env', defaultName(path, c.prefix), c);
  return rows;
}

// Saved row as is; env row -> SavedConnection, asking the type when it could not be guessed.
async function toSaved(t: Term, r: Row): Promise<SavedConnection | null> {
  if (!r.from) return r.conn as SavedConnection;
  const c = r.conn as EnvCandidate;
  let type = c.type;
  if (!type) {
    const s = await select(t, `Jenis untuk ${r.name}?`, [{ label: 'postgres' }, { label: 'mysql' }], { quitLabel: 'kembali' });
    if (!s) return null;
    type = s.index ? 'mysql' : 'postgres';
  }
  return { name: r.name, type, host: c.host, port: c.port ?? DEFAULTS[type].port, user: c.user || DEFAULTS[type].user,
    password: c.password, database: c.database, ...(c.ssl ? { ssl: c.ssl } : {}) };
}

export async function runMenu(d: MenuDeps): Promise<number> {
  const t = d.term;
  const out = (s: string) => { t.output.write(s); };
  const shown = new Set<string>();
  const once = (m: string) => { if (!shown.has(m)) { shown.add(m); out(m + '\n'); } };
  let cur = 0;
  out(logo(t, d.version));
  try {
    for (;;) {
      try {
        let saved: SavedConnection[] = [];
        try {
          const r = await loadConnections(d.storePath);
          saved = r.connections;
          r.warnings.forEach(once);
        } catch (err) { once(`Error: ${msg(err)}`); }
        const rows = [...await envRows(d, saved), ...saved.map((c): Row => ({ name: c.name, conn: c }))];
        if (!rows.length) { out('Belum ada koneksi. Tambah lewat "+ Tambah koneksi" (impor .env atau isi manual).\n'); cur = 0; }
        const w = Math.max(0, ...rows.map(r => r.name.length));
        const items = [
          ...rows.map(r => ({ label: r.name.padEnd(w), desc: `${r.conn.type ?? '?'}  ${r.conn.host}${r.from ? '  · ' + r.from : ''}` })),
          { label: '+ Tambah koneksi' }, { label: 'Pakai connection string sekali' },
        ];
        const s = await select(t, 'Pilih database', items, { initial: cur, keys: [{ key: 'd', label: 'hapus' }] });
        if (!s) return 0;
        cur = s.index;
        const row = rows[s.index];
        if (s.key === 'd') {
          if (row && !row.from && await confirm(t, `Hapus "${row.name}"?`)) {
            await removeConnection(d.storePath, row.name);
            out(`Terhapus: ${row.name}\n`);
          }
          continue;
        }
        if (s.index === rows.length) { await addMenu(d); continue; }
        let r: 'back' | 'quit';
        if (s.index === rows.length + 1) {
          const url = await ask(t, 'Connection string', { hidden: true });
          if (!url) continue;
          r = await session(d, '', url);
        } else {
          const c = await toSaved(t, row);
          if (!c) continue;
          r = await session(d, c.name, row.url ?? connectionUrl(c), row.from ? c : undefined);
        }
        if (r === 'quit') return 0;
      } catch (err) {
        out(`Error: ${redact(msg(err), d.env.DATABASE_URL)}\n`);
        // never re-loop without user input
        const a = await select(t, 'Terjadi error', [{ label: 'Coba lagi' }, { label: 'Keluar' }]);
        if (!a || a.index === 1) return 1;
      }
    }
  } finally {
    t.input.setRawMode?.(false);
    t.output.write('\x1b[?25h');
  }
}

async function addMenu(d: MenuDeps): Promise<void> {
  const s = await select(d.term, 'Tambah koneksi', [{ label: 'dari .env', desc: join(d.cwd, '.env') }, { label: 'manual' }], { quitLabel: 'kembali' });
  if (!s) return;
  const deps = { term: d.term, storePath: d.storePath, createAdapter: d.createAdapter, out: d.term.output };
  if (s.index === 0) await addFromEnv(deps, d.cwd); else await addManual(deps);
}

// Screen 2 for one open connection; closes it on the way out.
async function session(d: MenuDeps, name: string, url: string, unsaved?: SavedConnection): Promise<'back' | 'quit'> {
  const t = d.term;
  const out = (s: string) => { t.output.write(s); };
  const fail = (prefix: string, err: unknown) => out(`${prefix}${redact(msg(err), url)}\n`);
  let adapter: DbAdapter | undefined, info: ServerInfo, host = '';
  let stored = unsaved || !name ? undefined : name;   // store entry that receives server answers
  try {
    try {
      const config = parseConnectionUrl(url);
      host = hostOf(config);
      name ||= config.database;
      adapter = await d.createAdapter(config);
      info = await adapter.info();
    } catch (err) { fail('Gagal konek: ', err); return 'back'; }

    const run = async (parts: AnalysisPart[] | undefined, watchSeconds: number | undefined, server?: ServerMemory): Promise<AnalysisResult | null> => {
      const ac = new AbortController();
      const off = d.onInterrupt(() => ac.abort());
      try {
        const r = await analyze(adapter!, { connection: redactUrl(url), top: DEFAULT_TOP, parts, watchSeconds, server, today: d.now(), signal: ac.signal,
          onTick: n => out(`\r\x1b[KMenunggu snapshot kedua: ${n} detik…`) });
        if (watchSeconds) out('\r\x1b[K');
        return r;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') out('\r\x1b[KDibatalkan\n'); else fail('\r\x1b[KError: ', err);
        return null;
      } finally { off(); }
    };
    const guard = async (f: () => Promise<void>) => { try { await f(); } catch (err) { fail('Error: ', err); } };

    for (;;) {
      const items = [...CHOICES, ...(unsaved ? [{ label: 'Simpan koneksi ini' }] : []), ...(stored ? [{ label: 'Ubah info server' }] : []), { label: '← Kembali' }];
      const s = await select(t, `dbc › ${name} (${info.flavor} ${info.version})`, items, { quitLabel: 'kembali' });
      const label = s && items[s.index].label;
      if (!s || label === '← Kembali') return 'back';
      if (label === 'Simpan koneksi ini') {
        await guard(async () => { const n = await saveRow(d, unsaved!, info.version); if (n) { unsaved = undefined; stored = n; } });
        continue;
      }
      if (label === 'Ubah info server') {
        await guard(async () => { if (await serverMemory(d, stored, host, true)) out('Info server tersimpan.\n'); });
        continue;
      }
      const choice = CHOICES[s.index];
      let server: ServerMemory | undefined;
      if (!choice.parts || choice.parts.includes('config')) {
        const m = await serverMemory(d, stored, host, false);
        if (!m) continue;
        server = m;
      }
      let watchSeconds: number | undefined;
      if (choice.watch) {
        const v = await ask(t, 'Jeda (detik)', { default: '60' });
        if (v === null) continue;
        if (!/^[1-9]\d*$/.test(v)) { out('Jeda harus bilangan bulat positif.\n'); continue; }
        watchSeconds = Number(v);
      }
      for (;;) {
        const result = await run(choice.parts, watchSeconds, server);
        if (!result) break;
        const report = buildReport(result, { mask: true });
        out(renderTerminal(report, { color: t.color }));
        const a = await select(t, 'Selanjutnya', [{ label: 'Simpan ke .md' }, { label: 'Jalankan lagi' }, { label: 'Kembali ke menu' }, { label: 'Keluar' }], { quitLabel: 'kembali' });
        if (a?.index === 1) continue;
        if (a?.index === 3) return 'quit';
        if (a?.index === 0) await guard(() => saveReport(d, name, report));
        break;
      }
    }
  } finally {
    try { await adapter?.close(); } catch { /* error close tidak boleh menutupi hasil */ }
  }
}

async function saveReport(d: MenuDeps, name: string, report: Report): Promise<void> {
  const f = await ask(d.term, 'Nama file', { default: `./${name.replace(/[^A-Za-z0-9._-]/g, '-')}-${stamp(d.now())}.md` });
  if (!f) return;
  const path = resolve(d.cwd, f === '~' || f.startsWith('~/') ? homedir() + f.slice(1) : f);
  if (await exists(path) && !await confirm(d.term, `${path} sudah ada, timpa?`)) return;
  await writeFile(path, renderMarkdown(report));
  d.term.output.write(`Tersimpan: ${path}\n`);
}

// Saved name, or null when cancelled.
async function saveRow(d: MenuDeps, c: SavedConnection, version: string): Promise<string | null> {
  const name = await ask(d.term, 'Nama (alias)', { default: c.name });
  if (!name) return null;
  const { connections } = await loadConnections(d.storePath);
  if (connections.some(x => x.name === name) && !await confirm(d.term, `"${name}" sudah ada, timpa?`)) return null;
  await saveConnection(d.storePath, { ...c, name, version });
  d.term.output.write(`Tersimpan: ${name}\n`);
  return name;
}

// Server type + RAM for the config part: saved answers, else ask (saved into the stored entry). null = cancelled.
async function serverMemory(d: MenuDeps, stored: string | undefined, host: string, force: boolean): Promise<ServerMemory | null> {
  const t = d.term, local = isLocalHost(host), mem = d.memory ?? localMemory;
  const entry = stored ? (await loadConnections(d.storePath)).connections.find(c => c.name === stored) : undefined;
  if (!force && entry?.dedicated !== undefined && (entry.ram_mb || local)) {
    const dedicated = entry.dedicated;
    if (entry.ram_mb) return { totalMb: entry.ram_mb, source: 'manual', dedicated };
    try { return { ...await mem(), source: 'lokal', dedicated }; } catch { return { source: null, dedicated }; }
  }
  const s = await select(t, 'Server ini khusus database?', [{ label: 'Ya' }, { label: 'Berbagi dengan aplikasi' }], { quitLabel: 'kembali' });
  if (!s) return null;
  const dedicated = s.index === 0;
  let lm: Awaited<ReturnType<typeof mem>> | undefined;
  if (local) try { lm = await mem(); } catch { /* RAM tidak terbaca: tanpa default */ }
  const def = lm && (lm.totalMb % 1024 ? `${lm.totalMb}M` : `${lm.totalMb / 1024}G`);
  let ram: number | null = null;
  while (ram === null) {
    const v = await ask(t, `Besar RAM server (mis. 8G${def ? `; ${def} terbaca dari mesin ini` : ''})`, { default: def });
    if (v === null) return null;
    ram = parseSize(v);
    if (ram === null) t.output.write('Ukuran RAM tidak valid (contoh: 8G, 512M)\n');
  }
  if (entry) await saveConnection(d.storePath, { ...entry, dedicated, ram_mb: ram });
  // typed or confirmed by the user: 'manual'; free RAM only meaningful when it is this machine's RAM
  return { totalMb: ram, ...(lm?.availableMb !== undefined && lm.totalMb === ram ? { availableMb: lm.availableMb } : {}), source: 'manual', dedicated };
}
