import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, envCandidates, defaultName } from '../src/dotenv.js';

const ENV = `
# Laravel style; commented lines are inactive
APP_NAME=mes
DB_CONNECTION=pgsql
#DB_HOST=old-server
DB_HOST=10.0.0.5
DB_PORT=5433
DB_DATABASE=mes_dev
DB_USERNAME=mes
DB_PASSWORD="p@ss#word"   # quoted, inline comment
# DATABASE_URL=postgres://ignored:x@nowhere/ignored
REPORT_DATABASE_URL=mysql://rep:s%40cret@db.local:3307/reports?ssl=true
export PGHOST=pg.local
PGUSER=\${DB_USERNAME}
PGDATABASE=analytics
REDIS_HOST=127.0.0.1
REDIS_DB=0
MAIL_HOST=smtp
MAIL_USERNAME=x
`;

test('parseEnv ignores comments, strips quotes, expands ${VAR}', () => {
  const env = parseEnv(ENV);
  assert.equal('DATABASE_URL' in env, false);
  assert.equal(env.DB_HOST, '10.0.0.5');
  assert.equal(env.DB_PASSWORD, 'p@ss#word');
  assert.equal(env.PGUSER, 'mes');
});

test('envCandidates finds groups and URLs, groups first', () => {
  const list = envCandidates(parseEnv(ENV));
  assert.deepEqual(new Set(list.map((c) => c.src)), new Set(['DB_*', 'REPORT_DATABASE_URL', 'PG_*']));
  assert.equal(list[list.length - 1].src, 'REPORT_DATABASE_URL');
  const by = Object.fromEntries(list.map((c) => [c.src, c]));
  const pick = (c: typeof list[0]) => [c.type, c.host, c.port, c.user, c.password, c.database];
  assert.deepEqual(pick(by['DB_*']), ['postgres', '10.0.0.5', 5433, 'mes', 'p@ss#word', 'mes_dev']);
  assert.deepEqual(pick(by.REPORT_DATABASE_URL), ['mysql', 'db.local', 3307, 'rep', 's@cret', 'reports']);
  assert.equal(by.REPORT_DATABASE_URL.ssl, 'true');
  assert.deepEqual([by['PG_*'].type, by['PG_*'].host, by['PG_*'].port, by['PG_*'].user, by['PG_*'].database],
    ['postgres', 'pg.local', 5432, 'mes', 'analytics']);
});

test('URL schemes and ssl query', () => {
  const [a] = envCandidates({ A_URL: 'postgres://u:p@h/db?sslmode=require' });
  assert.equal(a.ssl, 'require');
  assert.equal(a.port, 5432);
  assert.equal(envCandidates({ A_URL: 'postgresql+psycopg://u:p@h/db' })[0].type, 'postgres');
  assert.equal(envCandidates({ A_URL: 'mariadb://u:p@h/db' })[0].type, 'mysql');
  assert.equal(envCandidates({ A_URL: 'mariadb://u:p@h/db' })[0].port, 3306);
});

test('group without type hint and unknown port has null type and port', () => {
  const [c] = envCandidates({ APP_HOST: 'h', APP_DATABASE: 'd', APP_USER: 'u' });
  assert.equal(c.type, null);
  assert.equal(c.port, null);
  // an explicit port is kept even when the type is unknown (as in dbb)
  assert.equal(envCandidates({ APP_HOST: 'h', APP_PORT: '1234', APP_DATABASE: 'd' })[0].port, 1234);
  assert.equal(envCandidates({ APP_HOST: 'h', APP_DATABASE: 'd' })[0].user, '');
});

test('same host/port/user/database from URL and group is one candidate', () => {
  const list = envCandidates({
    DB_CONNECTION: 'pgsql', DB_HOST: 'h', DB_DATABASE: 'd', DB_USERNAME: 'u',
    DATABASE_URL: 'postgres://u:p@h:5432/d?sslmode=require',
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].src, 'DATABASE_URL');
  assert.equal(list[0].ssl, 'require');
});

test('defaultName', () => {
  assert.equal(defaultName('/x/shop/.env.production', 'REPORT_DATABASE'), 'shop-production-report');
  assert.equal(defaultName('/x/shop/.env', ''), 'shop');
  assert.equal(defaultName('/x/shop/.env', 'DB'), 'shop');
});
