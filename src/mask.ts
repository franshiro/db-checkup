import type { Dialect } from './types.js';

// One-pass tokenizer. Each piece is flagged `lit` when it replaced a literal (emitted as `?`).
type Piece = { text: string; lit: boolean };

const IDENT = /[\p{L}\p{N}_$]/u;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\w*/y;
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/yu;
const DOLLAR_TAG = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/yu;

function tokenize(sql: string, dialect: Dialect): Piece[] {
  const out: Piece[] = [];
  const code = (text: string) => out.push({ text, lit: false });
  const lit = () => out.push({ text: '?', lit: true });
  const at = (re: RegExp, i: number) => { re.lastIndex = i; return re.exec(sql)?.[0]; };
  // End index (after closing quote) of a quoted run; sql.length when unterminated.
  const quoted = (i: number, q: string, backslash: boolean) => {
    for (let j = i + 1; j < sql.length; j++) {
      if (backslash && sql[j] === '\\') j++;
      else if (sql[j] === q) {
        if (sql[j + 1] === q) j++;
        else return j + 1;
      }
    }
    return sql.length;
  };

  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    let end: number | undefined;
    if (c === "'" || (c === '"' && dialect === 'mysql')) {
      // Postgres: backslash escapes only in E'...' strings; drop the E prefix with the literal.
      const estr = dialect === 'postgres' && c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !IDENT.test(sql[i - 2] ?? '');
      if (estr) out.pop();
      end = quoted(i, c, dialect === 'mysql' || estr);
      lit();
    }
    else if (c === '"' || (c === '`' && dialect === 'mysql')) { end = quoted(i, c, false); code(sql.slice(i, end)); }
    else if ((c === '-' && sql[i + 1] === '-') || (c === '#' && dialect === 'mysql')) { end = sql.indexOf('\n', i); end = end < 0 ? sql.length : end; code(' '); }
    else if (c === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest; MySQL's do not.
      let depth = 1;
      for (end = i + 2; end < sql.length && depth > 0; end++) {
        if (dialect === 'postgres' && sql.startsWith('/*', end)) { depth++; end++; }
        else if (sql.startsWith('*/', end)) { depth--; end++; }
      }
      code(' ');
    }
    else if (c === '$' && dialect === 'postgres' && at(DOLLAR_TAG, i)) {
      const tag = at(DOLLAR_TAG, i)!;
      const e = sql.indexOf(tag, i + tag.length);
      end = e < 0 ? sql.length : e + tag.length;
      lit();
    } else if (at(WORD, i)) { end = i + at(WORD, i)!.length; code(sql.slice(i, end)); }
    else if ((/\d/.test(c) || c === '.') && !(i > 0 && IDENT.test(sql[i - 1])) && at(NUMBER, i)) { end = i + at(NUMBER, i)!.length; lit(); }
    else { end = i + 1; code(c); }
    i = end;
  }
  return out;
}

export function maskSql(sql: string, dialect: Dialect): string {
  return tokenize(sql, dialect).map((p) => p.text).join('').replace(/\s+/g, ' ').trim();
}

export function hasPlaceholder(sql: string, dialect: Dialect): boolean {
  return tokenize(sql, dialect).some((p) => !p.lit && p.text.includes('?'));
}
