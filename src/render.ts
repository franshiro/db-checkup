import { styleText } from 'node:util';
import type { Block, Report } from './report.js';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function renderMarkdown(r: Report): string {
  const block = (b: Block) =>
    b.kind === 'table' ? [`| ${b.headers.join(' | ')} |`, `|${b.headers.map(() => ' --- ').join('|')}|`, ...b.rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n')
    : b.kind === 'code' ? '```sql\n' + b.text + '\n```' : b.text;
  return `# ${r.title}\n\n` + r.sections.map(s => `## ${s.title}\n\n${s.blocks.map(block).join('\n\n')}\n`).join('\n');
}

export function renderTerminal(r: Report, opts: { color: boolean }): string {
  // validateStream:false so colors follow the caller's choice, not Node's TTY check.
  const st = (f: 'bold' | 'yellow', t: string) => opts.color ? styleText(f, t, { validateStream: false }) : t;
  const block = (b: Block) => {
    if (b.kind === 'code') return b.text.split('\n').map(l => '  ' + l).join('\n');
    if (b.kind === 'text') return b.level === 'warn' ? st('yellow', b.text) : b.text;
    const cells = [b.headers, ...b.rows.map(row => row.map(c => c.replace(/\s*\n\s*/g, ' ')))];
    const w = b.headers.map((_, i) => Math.max(...cells.map(row => row[i].length)));
    const line = (row: string[]) => row.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
    return [st('bold', line(cells[0])), ...cells.slice(1).map(line)].join('\n');
  };
  return [st('bold', r.title), ...r.sections.map(s => `${st('bold', s.title)}\n${s.blocks.map(block).join('\n\n')}`)].join('\n\n') + '\n';
}
