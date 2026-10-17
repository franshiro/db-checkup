import { readFile, writeFile, rename, chmod, mkdir, stat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SavedConnection { name: string; type: 'postgres' | 'mysql'; host: string; port: number; user: string; password: string; database: string; version?: string; ssl?: string }

export class StoreError extends Error {}

const DEFAULT_PORT = { postgres: 5432, mysql: 3306 };

export function storePath(env: Record<string, string | undefined>, home: string = homedir()): string {
  if (env.DBB_CONFIG) return env.DBB_CONFIG;
  return join(env.DBB_HOME || join(home, '.dbb'), 'databases.json');
}

// Raw parsed array, or [] when the file is absent. Errors never include file content.
async function readRaw(path: string): Promise<unknown[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw new StoreError('File koneksi tidak bisa dibaca.');
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new StoreError('File koneksi rusak (bukan JSON valid); tidak diubah.'); }
  if (!Array.isArray(data)) throw new StoreError('File koneksi rusak (harus berupa array); tidak diubah.');
  return data;
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

export async function loadConnections(path: string): Promise<{ connections: SavedConnection[]; warnings: string[] }> {
  const raw = await readRaw(path);
  const seen = new Set<string>();
  const connections: SavedConnection[] = [];
  for (const e of raw) {
    if (!isObj(e)) continue;
    if (e.name && seen.has(e.name)) continue;
    if (e.name) seen.add(e.name); // a hidden first entry shadows later duplicates, like save/remove
    if (!e.name || !e.host || !e.user || !e.database) continue;
    if (e.type !== 'postgres' && e.type !== 'mysql') continue;
    connections.push({ ...e, port: e.port || DEFAULT_PORT[e.type as 'postgres' | 'mysql'], password: e.password ?? '' } as SavedConnection);
  }
  const warnings: string[] = [];
  try {
    if ((await stat(path)).mode & 0o077) warnings.push('Izin file koneksi terlalu longgar (berisi password); jalankan: chmod 600 ' + path);
  } catch { /* absent */ }
  return { connections, warnings };
}

async function writeAll(path: string, list: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await chmod(path, 0o600);
}

export async function saveConnection(path: string, c: SavedConnection): Promise<void> {
  const raw = await readRaw(path);
  const i = raw.findIndex(e => isObj(e) && e.name === c.name);
  if (i >= 0) raw[i] = { ...(raw[i] as object), ...c }; else raw.push(c);
  await writeAll(path, raw);
}

export async function removeConnection(path: string, name: string): Promise<boolean> {
  const raw = await readRaw(path);
  const i = raw.findIndex(e => isObj(e) && e.name === name);
  if (i < 0) return false;
  raw.splice(i, 1);
  await writeAll(path, raw);
  return true;
}

export function connectionUrl(c: SavedConnection): string {
  const q = c.ssl ? `?${c.type === 'postgres' ? 'sslmode' : 'ssl'}=${encodeURIComponent(c.ssl)}` : '';
  const scheme = c.type === 'postgres' ? 'postgresql' : 'mysql';
  return `${scheme}://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${encodeURIComponent(c.database)}${q}`;
}
