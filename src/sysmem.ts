import os from 'node:os';
import { readFile } from 'node:fs/promises';
import type { ConnectionConfig } from './connection.js';

// Host dianggap lokal: loopback, socket Unix, atau kosong (default lokal).
export function isLocalHost(host: string): boolean {
  return host === '' || host.startsWith('/') || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export async function localMemory(read: (p: string) => Promise<string> = (p) => readFile(p, 'utf8')): Promise<{ totalMb: number; availableMb?: number }> {
  const totalMb = Math.floor(os.totalmem() / 1048576);
  if (process.platform !== 'linux') return { totalMb };
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(await read('/proc/meminfo'));
    return m ? { totalMb, availableMb: Math.floor(Number(m[1]) / 1024) } : { totalMb };
  } catch {
    return { totalMb };
  }
}

export function hostOf(c: ConnectionConfig): string {
  if (c.dialect === 'mysql') return c.mysql.host;
  const u = new URL(c.url);
  const socket = u.searchParams.get('host');
  if (socket) return socket;
  return u.hostname.replace(/^\[(.*)\]$/, '$1');
}
