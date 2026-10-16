export interface MysqlOptions { host: string; port: number; user: string; password: string; database: string; ssl?: { rejectUnauthorized?: boolean } }
export type ConnectionConfig =
  | { dialect: 'postgres'; url: string; database: string }
  | { dialect: 'mysql'; database: string; mysql: MysqlOptions };

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
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (u.protocol === 'postgres:' || u.protocol === 'postgresql:') {
    return { dialect: 'postgres', url, database: dbName || decodeURIComponent(u.username) };
  }
  if (u.protocol === 'mysql:') {
    if (!dbName) throw new Error('Connection string MySQL harus menyertakan nama database, mis. mysql://user@host/nama_db');
    const ssl = u.searchParams.get('ssl');
    const mysql: MysqlOptions = {
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: dbName,
    };
    if (ssl === 'true') mysql.ssl = {};
    else if (ssl === 'skip-verify') mysql.ssl = { rejectUnauthorized: false };
    return { dialect: 'mysql', database: dbName, mysql };
  }
  throw new Error('Scheme tidak didukung. Gunakan postgres:// atau mysql://');
}

export function redactUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return '[connection string tidak valid]'; }
  if (u.password) u.password = '***';
  return u.toString();
}
