#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseConnectionUrl, redactUrl } from './connection.js';
import type { ConnectionConfig } from './connection.js';
import { createPostgresAdapter } from './adapters/postgres.js';
import { createMysqlAdapter } from './adapters/mysql.js';
import { analyze } from './analyze.js';
import { buildReport } from './report.js';
import { renderMarkdown, renderTerminal } from './render.js';
import { DEFAULT_TOP } from './types.js';
import type { DbAdapter } from './types.js';

type Out = { write(s: string): void; isTTY?: boolean };

const USAGE = `Penggunaan: db-checkup [connection-string] [opsi]

Analisa database Postgres/MySQL (hanya membaca): query lambat, saran index, kondisi saat ini.

Argumen:
  connection-string   postgres://user:pass@host/db atau mysql://user:pass@host/db
                      (kalau kosong, dibaca dari env DATABASE_URL)

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
  io: { stdout: Out; stderr: Out }, deps: { createAdapter(c: ConnectionConfig): Promise<DbAdapter> } = { createAdapter: defaultCreateAdapter }): Promise<number> {
  const { stdout, stderr } = io;
  let url: string | undefined;
  // Semua pesan ke stderr melewati sini: password (asli dan hasil decode) diganti ***.
  const fail = (msg: string, code: number) => {
    msg = redact(msg, url);
    stderr.write(msg + '\n');
    return code;
  };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      output: { type: 'string' }, top: { type: 'string' }, watch: { type: 'string' },
      'no-mask': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
    } });
  } catch (err) { return fail(`Error: ${(err as Error).message}\n\n${USAGE}`, 2); }
  const { values, positionals } = parsed;

  if (values.help) { stdout.write(USAGE); return 0; }
  if (values.version) {
    const { createRequire } = await import('node:module');
    stdout.write(`${createRequire(import.meta.url)('../package.json').version}\n`);
    return 0;
  }
  const top = positiveInt(values.top, DEFAULT_TOP), watchSeconds = positiveInt(values.watch);
  if (Number.isNaN(top)) return fail('Error: --top harus bilangan bulat positif.', 2);
  if (Number.isNaN(watchSeconds)) return fail('Error: --watch harus bilangan bulat positif (detik).', 2);

  url = positionals[0] ?? env.DATABASE_URL;
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
  const io = { stdout: process.stdout, stderr: process.stderr };
  const argv = process.argv.slice(2);
  main(argv, process.env, io).then(code => { process.exitCode = code; }).catch(err => {
    // Url tidak diketahui di sini, jadi coba semua argumen dan DATABASE_URL sebagai kandidat.
    const msg = ([...argv, process.env.DATABASE_URL] as (string | undefined)[]).reduce((m: string, u) => redact(m, u), `Error: ${(err as Error).message}`);
    process.stderr.write(msg + '\n');
    process.exitCode = 1;
  });
}
