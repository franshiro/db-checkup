import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSql, hasPlaceholder } from '../src/mask.js';

const m = maskSql;
test('strings and numbers', () =>
  assert.equal(m("SELECT * FROM users WHERE email = 'budi@x.com' AND id = 42", 'mysql'), 'SELECT * FROM users WHERE email = ? AND id = ?'));
test('doubled and backslash quotes', () => {
  assert.equal(m("WHERE name = 'O''Brien'", 'postgres'), 'WHERE name = ?');
  assert.equal(m("WHERE a = 'it\\'s' AND b = 1", 'mysql'), 'WHERE a = ? AND b = ?');
});
test('identifiers untouched', () => {
  assert.equal(m('SELECT t1.col_2 FROM "Orders" o WHERE o.v = 3.5', 'postgres'), 'SELECT t1.col_2 FROM "Orders" o WHERE o.v = ?');
  assert.equal(m('SELECT `col1` FROM `t2`', 'mysql'), 'SELECT `col1` FROM `t2`');
});
test('mysql double quotes are strings', () => assert.equal(m('WHERE a = "secret"', 'mysql'), 'WHERE a = ?'));
test('pg dollar quotes masked, params kept', () => assert.equal(m('SELECT $tag$secret$tag$, $1', 'postgres'), 'SELECT ?, $1'));
test('unterminated quote masks to end', () => assert.equal(m("INSERT INTO t VALUES ('abc", 'mysql'), 'INSERT INTO t VALUES (?'));
test('comments dropped, whitespace collapsed', () => assert.equal(m('SELECT 1 -- token=abc\nFROM   t /* x */', 'postgres'), 'SELECT ? FROM t'));
test('numeric forms', () => assert.equal(m('a=1e10 b=0xFF c=1.5e-3', 'mysql'), 'a=? b=? c=?'));
test('hasPlaceholder', () => {
  assert.equal(hasPlaceholder("SELECT * FROM t WHERE a = ?", 'mysql'), true);
  assert.equal(hasPlaceholder("SELECT * FROM t WHERE a = 'what?'", 'mysql'), false);
});
test('pg nested comments dropped', () => assert.equal(m('SELECT 1 /* a /* b */ secret */ FROM t', 'postgres'), 'SELECT ? FROM t'));
test('mysql # comment dropped, pg # kept', () => {
  assert.equal(m("SELECT 1 # token='abc'\nFROM t", 'mysql'), 'SELECT ? FROM t');
  assert.equal(m('SELECT a # b FROM t', 'postgres'), 'SELECT a # b FROM t');
});
test('pg backslash only escapes in E strings', () => {
  assert.equal(m("WHERE a = 'a\\' AND x = 'secret'", 'postgres'), 'WHERE a = ? AND x = ?');
  assert.equal(m("WHERE a = E'it\\'s' AND b = 1", 'postgres'), 'WHERE a = ? AND b = ?');
});
test('pg unicode dollar tag', () => assert.equal(m('SELECT $é$secret$é$', 'postgres'), 'SELECT ?'));
