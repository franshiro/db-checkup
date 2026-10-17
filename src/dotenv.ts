import { basename, dirname, parse, resolve } from 'node:path';

export interface EnvCandidate {
  src: string; prefix: string; type: 'postgres' | 'mysql' | null;
  host: string; port: number | null; user: string; password: string; database: string; ssl?: string;
}
type Type = 'postgres' | 'mysql';

const DEFAULTS: Record<Type, { port: number; user: string }> = {
  postgres: { port: 5432, user: 'postgres' },
  mysql: { port: 3306, user: 'root' },
};
// Key suffix -> field; matched longest first so DB_USERNAME is "user", not "name".
const SUFFIX: Record<string, string> = {
  HOST: 'host', HOSTNAME: 'host', SERVER: 'host', PORT: 'port',
  USER: 'user', USERNAME: 'user', PASSWORD: 'password', PASS: 'password', PWD: 'password',
  NAME: 'database', DATABASE: 'database', DB: 'database', DBNAME: 'database',
  CONNECTION: 'type', TYPE: 'type', DIALECT: 'type', DRIVER: 'type', ENGINE: 'type',
};
const SUFFIXES = Object.keys(SUFFIX).sort((a, b) => b.length - a.length);
const SKIP = ['REDIS', 'MONGO', 'CACHE', 'QUEUE', 'MAIL', 'SMTP', 'ELASTIC', 'RABBIT', 'AMQP', 'KAFKA', 'AWS', 'S3'];

// Active KEY=VALUE pairs; lines starting with # are ignored, ${VAR} expands from the same file.
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (k.startsWith('export ')) k = k.slice(7).trim();
    const end = /^['"]/.test(v) ? v.indexOf(v[0], 1) : -1;
    v = end > 0 ? v.slice(1, end) : v.split(/\s+#/)[0].trim();
    env[k] = v;
  }
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_, n) => env[n] ?? '')]));
}

function dbType(s: string | undefined): Type | null {
  s = (s ?? '').toLowerCase();
  if (s.includes('postgres') || s === 'pgsql' || s === 'pg') return 'postgres';
  if (s.includes('mysql') || s.includes('maria')) return 'mysql';
  return null;
}

const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

function fromUrl(src: string, v: string): EnvCandidate | null {
  const type = dbType(v.split('://')[0].split('+')[0]);
  if (!type) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  const ssl = u.searchParams.get(type === 'postgres' ? 'sslmode' : 'ssl');
  return {
    src, prefix: src.replace(/_?(URL|URI|DSN)$/, ''), type,
    host: u.hostname || 'localhost', port: u.port ? Number(u.port) : DEFAULTS[type].port,
    user: dec(u.username) || DEFAULTS[type].user, password: dec(u.password),
    database: dec(u.pathname.replace(/^\/+/, '')), ...(ssl ? { ssl } : {}),
  };
}

// Database configs in env: connection URLs and PREFIX_HOST/PORT/USER/... groups (groups first).
export function envCandidates(env: Record<string, string>): EnvCandidate[] {
  const urls: EnvCandidate[] = [];
  const groups = new Map<string, Record<string, string>>();
  for (const [k, v] of Object.entries(env)) {
    if (v.includes('://')) { const c = fromUrl(k, v); if (c) urls.push(c); }
    for (const suf of SUFFIXES) {
      const prefix = k.slice(0, k.length - suf.length);
      if (k.endsWith(suf) && (prefix === '' || prefix.endsWith('_') || prefix === 'PG')) {
        const g = groups.get(prefix.replace(/_+$/, '')) ?? {};
        groups.set(prefix.replace(/_+$/, ''), g);
        if (!(SUFFIX[suf] in g)) g[SUFFIX[suf]] = v;
        break;
      }
    }
  }
  const found: EnvCandidate[] = [];
  for (const [prefix, g] of groups) {
    if (SKIP.some((x) => prefix.includes(x)) || !g.database || !(g.host || g.user)) continue;
    const port = g.port ?? '';
    const type = dbType(g.type) ?? dbType(prefix) ?? ({ '5432': 'postgres', '3306': 'mysql' } as const)[port as '5432'] ?? null;
    found.push({
      src: prefix ? `${prefix}_*` : '*', prefix, type, host: g.host || 'localhost',
      port: /^\d+$/.test(port) ? Number(port) : type ? DEFAULTS[type].port : null,
      user: g.user || (type ? DEFAULTS[type].user : ''), password: g.password ?? '', database: g.database,
    });
  }
  const seen = new Set<string>();
  return [...found, ...urls].filter((c) => {
    const key = JSON.stringify([c.host, c.port, c.user, c.database]);
    return !seen.has(key) && !!seen.add(key);
  });
}

// <project folder>[-<env variant>][-<prefix>], e.g. /x/shop/.env.production + REPORT_DATABASE -> shop-production-report
export function defaultName(envPath: string, prefix: string): string {
  const file = basename(envPath);
  const variant = file.startsWith('.env') ? file.slice(4).replace(/^\.+/, '') : parse(file).name;
  const extra = prefix.replace(/_?(DATABASE|DB)$/, '').toLowerCase().replace(/_/g, '-');
  return [basename(dirname(resolve(envPath))), variant, extra].filter(Boolean).join('-');
}
