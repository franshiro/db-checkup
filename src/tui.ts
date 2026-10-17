import { emitKeypressEvents, type Key } from 'node:readline';
import { styleText } from 'node:util';

export interface Term {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(on: boolean): unknown };
  output: { write(s: string): unknown; columns?: number; rows?: number };
  color: boolean;
}
export interface Item { label: string; desc?: string }

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

const paint = (t: Term, f: 'bold' | 'dim' | 'cyan', s: string) => t.color ? styleText(f, s, { validateStream: false }) : s;
const width = (t: Term) => Math.max(10, (t.output.columns ?? 80) - 1);
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// Feeds keypresses to `on` until it returns a value; raw mode and listener are always restored.
async function keys<T>(t: Term, on: (str: string | undefined, key: Key) => T | undefined): Promise<T> {
  emitKeypressEvents(t.input);
  t.input.setRawMode?.(true);
  t.input.resume();
  let handler!: (s: string | undefined, k: Key) => void;
  try {
    return await new Promise<T>((resolve) => {
      handler = (s, k) => { const r = on(s, k ?? {}); if (r !== undefined) resolve(r); };
      t.input.on('keypress', handler);
    });
  } finally {
    t.input.removeListener('keypress', handler);
    t.input.setRawMode?.(false);
    t.input.pause();
  }
}

const cancelKey = (k: Key) => k.name === 'escape' || (k.ctrl === true && k.name === 'c');

export async function select(
  t: Term, title: string, items: Item[], opts: { initial?: number; keys?: string[] } = {},
): Promise<{ index: number; key: string } | null> {
  const extra = opts.keys ?? [];
  const w = width(t);
  const help = clip(['↑↓ pilih', 'Enter buka', ...extra.map((k) => `${k} ${k}`), 'q keluar'].join(' · '), w);
  const n = items.length;
  let cur = Math.min(Math.max(opts.initial ?? 0, 0), Math.max(n - 1, 0));
  let top = 0, drawn = 0;

  const draw = () => {
    const view = Math.max(3, (t.output.rows ?? 24) - 5);
    if (cur < top) top = cur;
    if (cur >= top + view) top = cur - view + 1;
    const lines = [paint(t, 'bold', clip(title, w)), ''];
    for (let i = top; i < Math.min(n, top + view); i++) {
      const it = items[i];
      const row = clip(`${i === cur ? '➤' : ' '} ${it.label}${it.desc ? '  ' + it.desc : ''}`, w);
      lines.push(i === cur ? paint(t, 'cyan', row) : row);
    }
    lines.push('', paint(t, 'dim', help));
    t.output.write((drawn ? `\x1b[${drawn}A\r` : '') + lines.map((l) => '\x1b[2K' + l + '\n').join('') + '\x1b[J');
    drawn = lines.length;
  };

  t.output.write(HIDE);
  try {
    draw();
    return await keys(t, (s, k) => {
      if (cancelKey(k) || s === 'q') return null;
      if (k.name === 'return' || k.name === 'enter') return n ? { index: cur, key: 'enter' } : undefined;
      if (k.name === 'down' || s === 'j') cur = (cur + 1) % n;
      else if (k.name === 'up' || s === 'k') cur = (cur - 1 + n) % n;
      else if (s && extra.includes(s)) return { index: cur, key: s };
      else return undefined;
      draw();
      return undefined;
    });
  } finally {
    t.output.write(SHOW);
  }
}

export async function ask(t: Term, label: string, opts: { default?: string; hidden?: boolean } = {}): Promise<string | null> {
  let buf = '';
  t.output.write(`${label}${opts.default ? ` [${opts.default}]` : ''}: `);
  try {
    return await keys(t, (s, k) => {
      if (cancelKey(k)) return null;
      if (k.name === 'return' || k.name === 'enter') { t.output.write('\n'); return buf || opts.default || ''; }
      if (k.name === 'backspace') {
        if (buf) { buf = buf.slice(0, -1); if (!opts.hidden) t.output.write('\b \b'); }
      } else if (s && s >= ' ' && !k.ctrl && !k.meta) {
        buf += s;
        if (!opts.hidden) t.output.write(s);
      }
      return undefined;
    });
  } finally {
    t.output.write(SHOW);
  }
}

export async function confirm(t: Term, question: string, def = false): Promise<boolean> {
  t.output.write(`${question} ${def ? '[Y/n]' : '[y/N]'} `);
  const r = await keys(t, (s, k) => {
    if (cancelKey(k)) return false;
    if (k.name === 'return' || k.name === 'enter') return def;
    if (s === 'y' || s === 'Y') return true;
    if (s === 'n' || s === 'N') return false;
    return undefined;
  });
  t.output.write(r ? 'ya\n' : 'tidak\n');
  return r;
}

export function logo(t: Term, version: string): string {
  const art = [
    '     _ _',
    '  __| | |__   ___',
    ' / _` | \'_ \\ / __|',
    '| (_| | |_) | (__',
    ' \\__,_|_.__/ \\___|',
  ].map((l) => paint(t, 'cyan', l)).join('\n');
  return `${art}\n${paint(t, 'dim', `analisa database · hanya membaca · v${version}`)}\n\n`;
}
