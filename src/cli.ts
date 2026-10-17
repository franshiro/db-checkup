#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseConnectionUrl, redactUrl } from './connection.js';
import type { ConnectionConfig } from './connection.js';
import { createPostgresAdapter } from './adapters/postgres.js';
import { createMysqlAdapter } from './adapters/mysql.js';
import { analyze } from './analyze.js';
import { buildReport } from './report.js';
import { renderMarkdown, renderTerminal } from './render.js';
import { DEFAULT_TOP } from './types.js';
import type { DbAdapter } from './types.js';
import { addFromEnv, addManual } from './add.js';
import { connectionUrl, loadConnections, removeConnection, storePath } from './store.js';
import { confirm, select } from './tui.js';
import type { Term } from './tui.js';
import { runMenu } from './menu.js';

type Out = { write(s: string): void; isTTY?: boolean };

const USAGE = `Penggunaan: dbc [connection-string | nama | perintah] [opsi]
       (db-checkup adalah nama lain untuk perintah yang sama)

Analisa database Postgres/MySQL (hanya membaca): query lambat, saran index, kondisi saat ini.

Tanpa argumen di terminal interaktif, dbc membuka menu: pilih koneksi, pilih jenis analisa,
lalu simpan laporan ke file Markdown.

Argumen:
  connection-string   postgres://user:pass@host/db atau mysql://user:pass@host/db
                      (kalau kosong, dibaca dari env DATABASE_URL)

Perintah:
  add [--env [FILE|DIR]]   tambah koneksi (interaktif, atau impor dari .env)
  list                     daftar koneksi tersimpan
  remove [nama] [--yes]    hapus koneksi tersimpan
  <nama>                   analisa koneksi tersimpan

Opsi:
  --top <n>           jumlah query teratas (default ${DEFAULT_TOP})
  --watch <detik>     ambil dua snapshot dengan jeda sekian detik
  --output <file>     simpan laporan sebagai file Markdown
  --no-mask           jangan samarkan literal di dalam query
  --version           tampilkan versi
  --help              tampilkan bantuan ini
`;

const defaultCreateAdapter = (c: ConnectionConfig) =>
  c.dialect === 'postgres' ? createPostgresAdapter(c.url) : createMysqlAdapter(c.mysql);

const positiveInt = (s: string | undefined, fallback?: number) =>
  s === undefined ? fallback : /^[1-9]\d*$/.test(s) ? Number(s) : NaN;

// Ganti password (asli dan hasil decode) di msg dengan ***.
export function redact(msg: string, url: string | undefined): string {
  const secrets = new Set<string>();
  try {
    const u = new URL(url ?? '');
    for (const pw of [u.password, u.searchParams.get('password'), u.searchParams.get('sslpassword')]) {
      if (!pw) continue;
      secrets.add(pw);
      try { secrets.add(decodeURIComponent(pw)); } catch { /* escape rusak: cukup samarkan versi asli */ }
    }
  } catch { /* url tidak valid: tidak ada password */ }
  for (const s of secrets) if (s) msg = msg.split(s).join('***');
  return msg;
}

export async function main(argv: string[], env: Record<string, string | undefined>,
  io: { stdout: Out; stderr: Out; stdin?: Term['input'] }, deps: { createAdapter(c: ConnectionConfig): Promise<DbAdapter>; storePath?: string } = { createAdapter: defaultCreateAdapter }): Promise<number> {
  const { stdout, stderr } = io;
  let url: string | undefined;
  // Semua pesan ke stderr melewati sini: password (asli dan hasil decode) diganti ***.
  const fail = (msg: string, code: number) => {
    msg = redact(msg, url);
    stderr.write(msg + '\n');
    return code;
  };

  // `--env` tanpa nilai berarti folder saat ini.
  argv = argv.flatMap((a, i) => a === '--env' && (i === argv.length - 1 || argv[i + 1].startsWith('--')) ? [a, '.'] : [a]);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      output: { type: 'string' }, top: { type: 'string' }, watch: { type: 'string' },
      'no-mask': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' }, env: { type: 'string' }, yes: { type: 'boolean' },
    } });
  } catch (err) { return fail(`Error: ${(err as Error).message}\n\n${USAGE}`, 2); }
  const { values, positionals } = parsed;

  if (values.help) { stdout.write(USAGE); return 0; }
  const version = (): string => createRequire(import.meta.url)('../package.json').version;
  if (values.version) { stdout.write(`${version()}\n`); return 0; }
  const sp = deps.storePath ?? storePath(env);
  const term: Term | null = io.stdin?.isTTY && stdout.isTTY
    ? { input: io.stdin, output: stdout, color: !!stdout.isTTY && !env.NO_COLOR } : null;
  if (!argv.length && term) return runMenu({
    term, env, cwd: process.cwd(), storePath: sp, version: version(), createAdapter: deps.createAdapter, now: () => new Date(),
    onInterrupt: cb => { process.on('SIGINT', cb); return () => { process.off('SIGINT', cb); }; },
  });
  const cmd = positionals[0];
  const wrap = async (f: () => Promise<number>) => {
    try { return await f(); } catch (err) {
      return fail(`Error: ${(err as Error).message}`, 1);
    }
  };
  // Peringatan izin file dicetak sekali per perintah, sebelum menyentuh file.
  const load = async () => { const r = await loadConnections(sp); for (const w of r.warnings) stderr.write(w + '\n'); return r; };
  const addDeps = { term, storePath: sp, createAdapter: deps.createAdapter, out: stdout };
  if (cmd === 'add') return wrap(async () => {
    await load();
    if (values.env !== undefined) {
      const saved = await addFromEnv(addDeps, values.env);
      return saved.length || term ? 0 : 1;
    }
    if (!term) return fail('Error: dbc add butuh terminal interaktif; gunakan dbc add --env <file>.', 2);
    return await addManual(addDeps) ? 0 : 1;
  });
  if (cmd === 'list') return wrap(async () => {
    const { connections: list } = await load();
    if (!list.length) { stdout.write(`Belum ada koneksi. Tambah dengan \`dbc add\`  (file: ${sp})\n`); return 0; }
    const w = Math.max(4, ...list.map(c => c.name.length));
    stdout.write(`${'NAMA'.padEnd(w)}  ${'SERVER'.padEnd(18)}  ${'DATABASE'.padEnd(16)}  KONEKSI\n`);
    for (const c of list) stdout.write(`${c.name.padEnd(w)}  ${`${c.type} ${c.version ?? ''}`.trim().padEnd(18)}  ${c.database.padEnd(16)}  ${c.user}@${c.host}:${c.port}\n`);
    return 0;
  });
  if (cmd === 'remove') return wrap(async () => {
    const { connections: list } = await load();
    let name = positionals[1];
    if (!name) {
      if (!term) return fail('Error: sebutkan nama koneksi yang dihapus: dbc remove <nama> --yes', 2);
      if (!list.length) { stdout.write('Belum ada koneksi.\n'); return 0; }
      const s = await select(term, 'Hapus koneksi yang mana?', list.map(c => ({ label: c.name, desc: `${c.user}@${c.host}:${c.port}/${c.database}` })));
      if (!s) return 1;
      name = list[s.index].name;
    }
    if (!list.some(c => c.name === name)) return fail(`Error: koneksi "${name}" tidak ditemukan.`, 2);
    if (!values.yes) {
      if (!term) return fail(`Error: hapus "${name}" butuh konfirmasi; tambahkan --yes.`, 2);
      if (!await confirm(term, `Hapus "${name}"?`)) return 1;
    }
    await removeConnection(sp, name);
    stdout.write(`Terhapus: ${name}\n`);
    return 0;
  });

  const top = positiveInt(values.top, DEFAULT_TOP), watchSeconds = positiveInt(values.watch);
  if (Number.isNaN(top)) return fail('Error: --top harus bilangan bulat positif.', 2);
  if (Number.isNaN(watchSeconds)) return fail('Error: --watch harus bilangan bulat positif (detik).', 2);

  if (cmd && !cmd.includes('://')) {
    let saved;
    try { saved = (await load()).connections.find(c => c.name === cmd); } catch (err) { return fail(`Error: ${(err as Error).message}`, 1); }
    if (!saved) return fail(`Error: koneksi "${cmd}" tidak ditemukan. Lihat daftar dengan: dbc list`, 2);
    url = connectionUrl(saved);
  } else url = cmd ?? env.DATABASE_URL;
  if (!url) return fail('Error: connection string tidak ada. Berikan sebagai argumen atau set env DATABASE_URL.', 2);

  let config: ConnectionConfig;
  try { config = parseConnectionUrl(url); } catch (err) { return fail(`Error: ${(err as Error).message}`, 2); }

  let adapter: DbAdapter;
  try { adapter = await deps.createAdapter(config); } catch (err) {
    return fail(`Gagal konek ke database: ${(err as Error).message}`, 1);
  }
  try {
    const result = await analyze(adapter, {
      connection: redactUrl(url), top: top!, watchSeconds,
      onTick: n => { if (stderr.isTTY) stderr.write(`\r\x1b[KMenunggu snapshot kedua: ${n} detik…`); },
    });
    if (watchSeconds && stderr.isTTY) stderr.write('\r\x1b[K');
    const report = buildReport(result, { mask: !values['no-mask'] });
    stdout.write(renderTerminal(report, { color: !!stdout.isTTY && !env.NO_COLOR }));
    if (values.output) await writeFile(values.output, renderMarkdown(report));
    return 0;
  } catch (err) {
    return fail(`Error: ${(err as Error).message}`, 1);
  } finally {
    try { await adapter.close(); } catch { /* error close tidak boleh menutupi hasil */ }
  }
}

// Bandingkan realpath supaya tetap jalan lewat symlink bin hasil `npm install -g`.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const argv = process.argv.slice(2);
  main(argv, process.env, io).then(code => { process.exitCode = code; }).catch(err => {
    // Url tidak diketahui di sini, jadi coba semua argumen dan DATABASE_URL sebagai kandidat.
    const msg = ([...argv, process.env.DATABASE_URL] as (string | undefined)[]).reduce((m: string, u) => redact(m, u), `Error: ${(err as Error).message}`);
    process.stderr.write(msg + '\n');
    process.exitCode = 1;
  });
}
