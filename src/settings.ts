import { spawn } from 'node:child_process';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs a command attached to the terminal. `capture` collects stdout instead of showing it.
export type Run = (cmd: string, args: string[], opts: { cwd: string; capture?: boolean; stdinFile?: string }) => Promise<{ code: number; out: string }>;
export interface SettingsDeps { root: string; run: Run; out: { write(s: string): void } }

// Folder holding package.json and install.sh (dist/settings.js → ..; src/settings.ts → ..).
export const packageRoot = () => dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));

export const defaultRun: Run = (cmd, args, { cwd, capture, stdinFile }) => new Promise(res => {
  const p = spawn(cmd, args, { cwd, stdio: [stdinFile ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', 'inherit'] });
  if (stdinFile) createReadStream(stdinFile).pipe(p.stdin!);
  let out = '';
  p.stdout?.on('data', d => { out += d; });
  p.on('error', () => res({ code: 127, out }));
  p.on('close', code => res({ code: code ?? 1, out }));
});

const installer = (root: string) => join(root, 'install.sh');

export async function updateDbc(d: SettingsDeps): Promise<number> {
  if (!existsSync(installer(d.root))) {
    d.out.write(`dbc tidak dipasang lewat install.sh (${d.root}); update manual: git pull lalu npm run build.\n`);
    return 1;
  }
  if (existsSync(join(d.root, '.git'))) {
    const head = async () => (await d.run('git', ['-C', d.root, 'rev-parse', 'HEAD'], { cwd: d.root, capture: true })).out.trim();
    const before = await head();
    const pull = await d.run('git', ['-C', d.root, 'pull', '--ff-only'], { cwd: d.root });
    if (pull.code) { d.out.write('Gagal mengambil update (git pull).\n'); return pull.code; }
    if (await head() === before) { d.out.write('Sudah versi terbaru.\n'); return 0; }
  }
  const r = await d.run('bash', [installer(d.root)], { cwd: d.root });
  if (!r.code) d.out.write('Update selesai. Jalankan ulang dbc untuk memakai versi baru.\n');
  return r.code;
}

// Piped like `curl … | bash -s -- --uninstall`, so install.sh removes its managed folder
// (~/.db-checkup or DB_CHECKUP_DIR) but never a clone the user made elsewhere.
export async function uninstallDbc(d: SettingsDeps): Promise<number> {
  const r = await d.run('bash', ['-s', '--', '--uninstall'], { cwd: homedir(), stdinFile: installer(d.root) });
  if (!r.code) d.out.write('File koneksi (~/.dbb/databases.json) tidak dihapus karena dipakai juga oleh dbb.\n');
  return r.code;
}

export const settingsInfo = (version: string, root: string, storePath: string) =>
  `Versi dbc       ${version}\nLokasi install  ${root}\nFile koneksi    ${storePath}\n`;
