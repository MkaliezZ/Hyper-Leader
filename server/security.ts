// DSH integration follows the MIT self-media-bot reference; see THIRD_PARTY_NOTICES.md.
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
export function sameSecret(value: unknown, expected: string) { if (typeof value !== 'string') return false; const a = Buffer.from(value), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
export function browserRequest(headers: Record<string, any>, origin: string, mutation: boolean, csrf: string, cookie: string, bootstrap = false) {
  const url = new URL(origin); const hosts = new Set([url.host, `localhost:${url.port}`]);
  if (!hosts.has(String(headers.host ?? ''))) throw new AppError(403, '不接受此访问来源。', 'BAD_HOST');
  if (headers['sec-fetch-site'] === 'cross-site' || (headers.origin && ![origin, `http://localhost:${url.port}`].includes(headers.origin))) throw new AppError(403, '不接受跨站请求。', 'BAD_ORIGIN');
  const cookies = String(headers.cookie ?? '').split(';').map(s => s.trim());
  if (!bootstrap && !cookies.some(s => s.startsWith('leader_session=') && sameSecret(s.slice('leader_session='.length), cookie))) throw new AppError(401, '会话已更新，请刷新页面。', 'SESSION_REQUIRED');
  if (mutation && !sameSecret(headers['x-csrf-token'], csrf)) throw new AppError(403, '请求校验失败，请刷新页面。', 'CSRF');
}
export async function acquireLock(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 }); const file = path.join(home, 'server.lock'); const nonce = randomUUID(); const mine = { application: 'hyper-leader', pid: process.pid, nonce };
  try { await writeFile(file, JSON.stringify(mine), { flag: 'wx', mode: 0o600 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const old = JSON.parse(await readFile(file, 'utf8'));
    if (old.application !== mine.application || !Number.isSafeInteger(old.pid) || !old.nonce) throw new Error('发现无法确认归属的锁文件，请保留并检查数据目录。');
    let alive = true; try { process.kill(old.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new Error('同一数据目录已有 Hyper Leader 进程。请打开已有页面。');
    await unlink(file); await writeFile(file, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
  }
  return async () => { const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')); if (current.nonce === nonce) await unlink(file); };
}
