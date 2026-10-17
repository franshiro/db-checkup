import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { select, ask, confirm, logo, type Term } from '../src/tui.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function mk(extra: { columns?: number; rows?: number } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[] }) as PassThrough & { isTTY: boolean; raw: boolean[]; setRawMode(on: boolean): void };
  input.setRawMode = (on: boolean) => { input.raw.push(on); };
  const writes: string[] = [];
  const t: Term = { input, output: { write: (s: string) => writes.push(s), ...extra }, color: false };
  const send = (...keys: string[]) => setImmediate(() => keys.forEach((k) => input.write(k)));
  return { t, input, writes, send, out: () => writes.join('') };
}
const items = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];

test('select: down, down, enter', async () => {
  const m = mk(); m.send('\x1b[B', '\x1b[B', '\r');
  assert.deepEqual(await select(m.t, 'T', items), { index: 2, key: 'enter' });
  assert.equal(m.input.raw.at(-1), false);
  assert.ok(m.out().includes('\x1b[?25h'));
  assert.ok(m.out().includes('➤'));
});

test('select: up wraps', async () => {
  const m = mk(); m.send('\x1b[A', '\r');
  assert.deepEqual(await select(m.t, 'T', items), { index: 2, key: 'enter' });
});

test('select: custom key, q, ctrl-c', async () => {
  let m = mk(); m.send('d');
  assert.deepEqual(await select(m.t, 'T', items, { keys: ['d'] }), { index: 0, key: 'd' });
  m = mk(); m.send('q');
  assert.equal(await select(m.t, 'T', items), null);
  m = mk(); m.send('\x03');
  assert.equal(await select(m.t, 'T', items), null);
  assert.equal(m.input.raw.at(-1), false);
});

test('ask hidden does not echo', async () => {
  const m = mk(); m.send('s', 'e', 'c', '\r');
  assert.equal(await ask(m.t, 'Sandi', { hidden: true }), 'sec');
  assert.ok(!m.out().includes('sec'));
});

test('ask default and cancel', async () => {
  let m = mk(); m.send('\r');
  assert.equal(await ask(m.t, 'Jeda', { default: '60' }), '60');
  m = mk(); m.send('\x03');
  assert.equal(await ask(m.t, 'Jeda'), null);
});

test('confirm', async () => {
  let m = mk(); m.send('y');
  assert.equal(await confirm(m.t, 'Yakin?'), true);
  m = mk(); m.send('\r');
  assert.equal(await confirm(m.t, 'Yakin?', true), true);
  m = mk(); m.send('n');
  assert.equal(await confirm(m.t, 'Yakin?', true), false);
});

test('narrow terminal clips lines', async () => {
  const m = mk({ columns: 40 }); m.send('\r');
  await select(m.t, 'T', [{ label: 'x'.repeat(120), desc: 'y'.repeat(120) }]);
  for (const w of m.writes) for (const line of strip(w).split('\n')) assert.ok(line.length <= 40, line);
});

test('scrolls long list', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `item-${i}` }));
  const m = mk({ rows: 10 }); m.send(...Array(25).fill('\x1b[B'), '\r');
  assert.deepEqual(await select(m.t, 'T', many), { index: 25, key: 'enter' });
  const last = m.writes.filter((w) => w.includes('item-')).at(-1)!;
  assert.ok(last.includes('item-25'));
});

test('logo has version', () => {
  assert.ok(strip(logo(mk().t, '1.2.3')).includes('v1.2.3'));
});
