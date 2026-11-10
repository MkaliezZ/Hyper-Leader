import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Domain, Json } from '../../shared/types.js';
import { Config } from '../../server/config.js';
import { AppError, invariant } from '../../server/errors.js';
import { contained, ownedFile } from '../../server/files.js';
import { Skills } from './skills.js';

export function rejectLocalReferences(value: unknown, allowed = new Set<string>()) {
  if (Array.isArray(value)) { value.forEach(item => rejectLocalReferences(item, allowed)); return; }
  if (value && typeof value === 'object') { Object.values(value).forEach(item => rejectLocalReferences(item, allowed)); return; }
  if (typeof value === 'string' && allowed.has(value)) return;
  if (typeof value === 'string' && (/file\s*:/i.test(value) || /^[A-Za-z]:[\\/]|^\\\\|^\/(?!\/)/.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value))) throw new AppError(403, '领域数据不能包含任意本机路径。请使用当前事项的资料引用。', 'DOMAIN_FILE_SCOPE');
}
export class Workers {
  constructor(readonly config: Config, readonly skills: Skills) {}
  async invoke(request: Json, signal?: AbortSignal): Promise<Json> {
    invariant((await this.config.public()).pythonReady, 503, '独立 Python 环境尚未就绪，请先运行 npm run setup。', 'PYTHON_UNAVAILABLE');
    const environment: NodeJS.ProcessEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) if (process.env[key]) environment[key] = process.env[key];
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.python(), ['-B', '-X', 'utf8', path.join(this.config.root, 'workers/worker.py')], { cwd: this.config.home, env: environment, shell: false, windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = ''; const timeout = setTimeout(() => child.kill(), 90000);
      child.stdout.on('data', data => { output += data.toString('utf8'); if (output.length > 8 * 1024 * 1024) child.kill(); });
      child.stderr.on('data', data => { if (error.length < 20000) error += data.toString('utf8'); });
      child.on('error', issue => { clearTimeout(timeout); reject(issue); });
      child.on('close', code => { clearTimeout(timeout); try { const result = JSON.parse(output); if (code !== 0 || !result.ok) throw new AppError(422, result.error || '领域操作未完成。', 'DOMAIN_REJECTED'); resolve(result.result); } catch (issue) { reject(issue instanceof AppError ? issue : new AppError(502, code === null ? '文档或领域操作已中断／超时，原件保持不变。' : `处理程序没有返回有效结果：${error.slice(0, 800)}`, 'WORKER_FAILED')); } });
      child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify({ ...request, allowed_root: this.config.home }));
    });
  }
  async parse(file: string, signal?: AbortSignal) { invariant(contained(this.config.home, file), 403, '资料路径越界。'); return this.invoke({ operation: 'parse_document', input_file: file }, signal); }
  async domain(spaceId: string, caseId: string, domain: Domain, operation: string, data: unknown, signal?: AbortSignal, allowedLocalUris: string[] = []) {
    const operations: Record<Domain, string[]> = { market: ['validate', 'render'], enterprise: ['match'], domestic: ['render'], international: ['evaluate', 'render'] };
    invariant(operations[domain]?.includes(operation), 400, '此领域操作未开放。', 'DOMAIN_OPERATION'); rejectLocalReferences(data, new Set(allowedLocalUris));
    const directory = path.join(this.config.home, 'domain-runs', spaceId, caseId); await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = path.join(directory, randomUUID());
    const result = await this.invoke({ domain, operation, data, method_root: this.skills.folder(domain), out_dir: output, as_of: new Date().toISOString().slice(0, 10), allowed_local_uris: allowedLocalUris }, signal);
    const files: { name: string; data: Buffer; mime: string }[] = [];
    const walk = async (folder: string) => { for (const entry of await readdir(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isSymbolicLink()) throw new AppError(403, '领域产物不能包含符号链接。'); if (entry.isDirectory()) await walk(file); else if (/\.(md|html|csv|json)$/i.test(file) && entry.name !== 'input.json') { const actual = await ownedFile(output, path.relative(output, file)); const bytes = await readFile(actual); invariant(bytes.length <= 8 * 1024 * 1024, 413, '单份领域产物超过大小限制。'); files.push({ name: path.relative(output, file).replaceAll('\\', '-'), data: bytes, mime: entry.name.endsWith('.html') ? 'text/html' : entry.name.endsWith('.md') ? 'text/markdown' : entry.name.endsWith('.csv') ? 'text/csv' : 'application/json' }); } } }; await walk(output);
    return { result, files };
  }
}
