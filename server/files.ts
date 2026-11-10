import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.js';
export async function jsonFile<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; } }
export async function atomicJson(file: string, data: unknown) { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${randomUUID()}.tmp`; try { await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temp, file); } finally { await unlink(temp).catch(() => undefined); } }
export function contained(root: string, target: string) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
export async function ownedFile(root: string, relative: string) { const base = await realpath(root); const file = await realpath(path.resolve(root, relative)).catch(() => { throw new AppError(404, '文件已不可用。', 'ASSET_UNAVAILABLE'); }); if (!contained(base, file)) throw new AppError(403, '不能读取当前资料范围以外的文件。', 'FILE_SCOPE'); return file; }
