import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseConnectionUrl } from './connection.js';
import type { ConnectionConfig } from './connection.js';
import { parseEnv, envCandidates, defaultName } from './dotenv.js';
import type { EnvCandidate } from './dotenv.js';
import { connectionUrl, loadConnections, saveConnection } from './store.js';
import type { SavedConnection } from './store.js';
import { ask, confirm, select } from './tui.js';
import type { Term } from './tui.js';
import { redact } from './cli.js';
import type { DbAdapter } from './types.js';

export interface AddDeps {
  term: Term | null; storePath: string;
  createAdapter(c: ConnectionConfig): Promise<DbAdapter>;
  out: { write(s: string): void };
}
type Type = 'postgres' | 'mysql';
const DEFAULTS: Record<Type, { port: number; user: string }> = { postgres: { port: 5432, user: 'postgres' }, mysql: { port: 3306, user: 'root' } };

export async function testConnection(d: AddDeps, c: SavedConnection): Promise<{ version: string } | { error: string }> {
  const url = connectionUrl(c);
  let adapter: DbAdapter | undefined;
  try {
    adapter = await d.createAdapter(parseConnectionUrl(url));
    return { version: (await adapter.info()).version };
  } catch (err) {
    let msg = redact((err as Error).message, url);
    if (c.password) msg = msg.split(c.password).join('***');
    return { error: msg };
  } finally {
    try { await adapter?.close(); } catch { /* error close tidak boleh menutupi hasil */ }
  }
}

// Uji lalu simpan. Gagal uji / nama sudah ada: tanya kalau interaktif, kalau tidak lewati.
async function saveNew(d: AddDeps, c: SavedConnection): Promise<boolean> {
  const r = await testConnection(d, c);
  if ('error' in r) {
    d.out.write(`Gagal konek: ${r.error}\n`);
    if (!d.term || !await confirm(d.term, 'Tetap simpan?')) { d.out.write(`  ${c.name} tidak disimpan\n`); return false; }
  } else {
    c = { ...c, version: r.version };
    d.out.write(`Terhubung: ${c.name} (${c.type} ${r.version})\n`);
  }
  const { connections } = await loadConnections(d.storePath);
  if (connections.some(x => x.name === c.name)) {
    if (!d.term || !await confirm(d.term, `"${c.name}" sudah ada, timpa?`)) { d.out.write(`  ${c.name} sudah ada, dilewati\n`); return false; }
  }
  await saveConnection(d.storePath, c);
  d.out.write(`Tersimpan: ${c.name}\n`);
  return true;
}

export async function addManual(d: AddDeps): Promise<SavedConnection | null> {
  const t = d.term;
  if (!t) { d.out.write('Mode non-interaktif: gunakan dbc add --env <file>.\n'); return null; }
  const sel = await select(t, 'Jenis database', [{ label: 'postgres' }, { label: 'mysql' }]);
  if (!sel) return null;
  const type: Type = sel.index === 0 ? 'postgres' : 'mysql';
  const def = DEFAULTS[type];
  const name = await ask(t, 'Nama (alias)');
  const host = name ? await ask(t, 'Host', { default: 'localhost' }) : null;
  const port = host ? await ask(t, 'Port', { default: String(def.port) }) : null;
  const user = port ? await ask(t, 'User', { default: def.user }) : null;
  const password = user ? await ask(t, 'Password', { hidden: true }) : null;
  const database = password !== null ? await ask(t, 'Nama database') : null;
  const ssl = database ? await ask(t, 'SSL (kosongkan kalau tidak perlu)') : null;
  if (!name || !host || !port || !user || password === null || !database || ssl === null) return null;
  if (!/^\d+$/.test(port)) { d.out.write('Port harus berupa angka.\n'); return null; }
  const c: SavedConnection = { name, type, host, port: Number(port), user, password, database, ...(ssl ? { ssl } : {}) };
  return await saveNew(d, c) ? c : null;
}

export async function addFromEnv(d: AddDeps, path: string): Promise<SavedConnection[]> {
  path = resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path);
  try { if ((await stat(path)).isDirectory()) path = join(path, '.env'); } catch { /* dilaporkan di bawah */ }
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { throw new Error(`${path} tidak ditemukan atau tidak bisa dibaca.`); }
  let found = envCandidates(parseEnv(text));
  if (!found.length) throw new Error(`Tidak ada pengaturan database aktif di ${path} (baris berberawalan # diabaikan).`);
  const names = new Map(found.map(f => [f, defaultName(path, f.prefix)]));
  const label = (f: EnvCandidate) => `${names.get(f)}  ${f.type ?? '?'}  ${f.database}  ${f.user}@${f.host}:${f.port ?? '?'}  ← ${f.src}`;
  const t = d.term;
  d.out.write(`${found.length} konfigurasi database ditemukan di ${path}\n`);
  if (t && found.length > 1) {
    const s = await select(t, 'Pilih yang mana?', [...found.map(f => ({ label: label(f) })), { label: 'Semuanya' }]);
    if (!s) return [];
    if (s.index < found.length) found = [found[s.index]];
  } else if (!t) for (const f of found) d.out.write('  ' + label(f) + '\n');

  const saved: SavedConnection[] = [];
  for (const f of found) {
    let name = names.get(f)!;
    let type = f.type, port = f.port, user = f.user;
    if (!type) {
      if (!t) { d.out.write(`Peringatan: ${name}: tidak bisa menentukan postgres atau mysql, dilewati\n`); continue; }
      const s = await select(t, `Jenis untuk ${name} (${f.src})?`, [{ label: 'postgres' }, { label: 'mysql' }]);
      if (!s) continue;
      type = s.index === 0 ? 'postgres' : 'mysql';
      port = port ?? DEFAULTS[type].port;
      user = user || DEFAULTS[type].user;
    }
    if (t) {
      const n = await ask(t, 'Nama (alias)', { default: name });
      if (!n) continue;
      name = n;
    }
    const c: SavedConnection = { name, type, host: f.host, port: port ?? DEFAULTS[type].port, user, password: f.password, database: f.database, ...(f.ssl ? { ssl: f.ssl } : {}) };
    if (await saveNew(d, c)) saved.push(c);
  }
  return saved;
}
