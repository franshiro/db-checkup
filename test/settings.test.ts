import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsInfo, uninstallDbc, updateDbc, type Run } from '../src/settings.js';

// Never runs anything: every command goes to this fake.
function fake(heads: string[] = ['a', 'a'], codes: Record<string, number> = {}) {
  const calls: { cmd: string; args: string[]; cwd: string; stdinFile?: string }[] = [];
  const run: Run = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, stdinFile: opts.stdinFile });
    if (cmd === 'git' && args.includes('rev-parse')) return { code: 0, out: heads.shift() + '\n' };
    return { code: codes[`${cmd} ${args[0]}`] ?? 0, out: '' };
  };
  let text = '';
  return { calls, run, out: { write: (s: string) => { text += s; } }, text: () => text };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dbc-settings-'));
  await writeFile(join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 99\n');
  await mkdir(join(root, '.git'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('update without install.sh: refuses with a hint, runs nothing', async () => {
  await rm(join(root, 'install.sh'));
  const f = fake();
  assert.equal(await updateDbc({ root, run: f.run, out: f.out }), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.text(), /install\.sh/);
});

test('update already up to date: git pull only, no reinstall', async () => {
  const f = fake(['abc', 'abc']);
  assert.equal(await updateDbc({ root, run: f.run, out: f.out }), 0);
  assert.ok(f.calls.some(c => c.cmd === 'git' && c.args.join(' ') === `-C ${root} pull --ff-only`));
  assert.ok(!f.calls.some(c => c.cmd === 'bash'));
  assert.match(f.text(), /Sudah versi terbaru/);
});

test('update with new commits: runs the local install.sh in the install folder', async () => {
  const f = fake(['abc', 'def']);
  assert.equal(await updateDbc({ root, run: f.run, out: f.out }), 0);
  const b = f.calls.find(c => c.cmd === 'bash');
  assert.deepEqual(b && { args: b.args, cwd: b.cwd }, { args: [join(root, 'install.sh')], cwd: root });
});

test('update: git pull failure stops before reinstall', async () => {
  const f = fake(['abc', 'abc'], { 'git -C': 1 });
  assert.equal(await updateDbc({ root, run: f.run, out: f.out }), 1);
  assert.ok(!f.calls.some(c => c.cmd === 'bash'));
});

test('uninstall pipes install.sh --uninstall from outside the install folder; connection file kept', async () => {
  const f = fake();
  assert.equal(await uninstallDbc({ root, run: f.run, out: f.out }), 0);
  assert.deepEqual(f.calls, [{ cmd: 'bash', args: ['-s', '--', '--uninstall'], cwd: homedir(), stdinFile: join(root, 'install.sh') }]);
  assert.match(f.text(), /databases\.json/);
});

test('uninstall failure returns its exit code', async () => {
  const f = fake([], { 'bash -s': 3 });
  assert.equal(await uninstallDbc({ root, run: f.run, out: f.out }), 3);
});

test('info lists version, install folder and connection file', () => {
  const s = settingsInfo('1.2.3', root, '/x/databases.json');
  assert.match(s, /1\.2\.3/);
  assert.ok(s.includes(root) && s.includes('/x/databases.json'));
});
