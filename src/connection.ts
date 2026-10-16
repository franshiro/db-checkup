export interface MysqlOptions { host: string; port: number; user: string; password: string; database: string; ssl?: { rejectUnauthorized?: boolean } }
export type ConnectionConfig =
  | { dialect: 'postgres'; url: string; database: string }
  | { dialect: 'mysql'; database: string; mysql: MysqlOptions };

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { throw new Error('Connection string tidak valid: ada escape persen (%) yang rusak di user, password, atau nama database.'); }
}

// Pesan error sengaja tidak memuat URL asli (bisa berisi password).
function toUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error('Connection string tidak valid. Gunakan postgres:// atau mysql://');
  }
}

export function parseConnectionUrl(url: string): ConnectionConfig {
  const u = toUrl(url);
  const dbName = decode(u.pathname.replace(/^\//, ''));
  if (u.protocol === 'postgres:' || u.protocol === 'postgresql:') {
    return { dialect: 'postgres', url, database: dbName || decode(u.username) };
  }
  if (u.protocol === 'mysql:') {
    if (!dbName) throw new Error('Connection string MySQL harus menyertakan nama database, mis. mysql://user@host/nama_db');
    const ssl = u.searchParams.get('ssl');
    const mysql: MysqlOptions = {
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decode(u.username),
      password: decode(u.password),
      database: dbName,
    };
    if (ssl === 'true') mysql.ssl = {};
    else if (ssl === 'skip-verify') mysql.ssl = { rejectUnauthorized: false };
    else if (ssl !== null) throw new Error('Nilai ssl tidak dikenal. Gunakan ssl=true atau ssl=skip-verify.');
    return { dialect: 'mysql', database: dbName, mysql };
  }
  throw new Error('Scheme tidak didukung. Gunakan postgres:// atau mysql://');
}

export function redactUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return '[connection string tidak valid]'; }
  if (u.password) u.password = '***';
  for (const k of ['password', 'sslpassword']) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
  return u.toString();
}
