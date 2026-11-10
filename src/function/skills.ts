import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { Domain } from '../../shared/types.js';
import { domains } from '../judgment/policy.js';
import { AppError, invariant } from '../../server/errors.js';
import { contained, ownedFile } from '../../server/files.js';

export class Skills {
  private roots = new Map<Domain, string>();
  private files = new Map<Domain, string[]>();
  readonly protocolRoot: string;
  constructor(readonly root: string, readonly home: string) { this.protocolRoot = path.join(root, '30-业务资料库/00-原始材料与研究输入/来源快照/Hyper-Protocol-v0.2-agent-draft-20261108'); }
  async init() {
    for (const [key, spec] of Object.entries(domains)) {
      const domain = key as Domain;
      const archive = path.join(this.root, '30-业务资料库/00-原始材料与研究输入/原始包', spec.archive);
      const data = await readFile(archive).catch(() => null); if (!data) continue;
      invariant(createHash('sha256').update(data).digest('hex') === spec.sha256, 409, `${spec.title}原始包指纹不一致，请恢复获准版本。`, 'METHOD_HASH');
      const target = path.join(this.home, 'methods', `${domain}-${spec.sha256.slice(0, 12)}`); await mkdir(target, { recursive: true, mode: 0o700 });
      const entries = unzipSync(data); let total = 0;
      for (const [name, bytes] of Object.entries(entries)) {
        if (!name.startsWith(`${spec.prefix}/`) || name.endsWith('/')) continue;
        const relative = name.slice(spec.prefix.length + 1);
        invariant(relative && !relative.includes('\\') && !relative.includes(':') && !relative.split('/').some(s => s === '.' || s === '..'), 400, '原包包含不安全路径。');
        total += bytes.length; invariant(total <= 32 * 1024 * 1024 && bytes.length <= 4 * 1024 * 1024, 400, '方法包超过资源限制。');
        const file = path.resolve(target, relative); invariant(contained(target, file), 403, '方法路径越界。');
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const previous = await readFile(file).catch(() => null);
        if (!previous) await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        else invariant(createHash('sha256').update(previous).digest('hex') === createHash('sha256').update(bytes).digest('hex'), 409, '方法缓存已被修改，请使用新版本适配，不覆盖原方法。', 'METHOD_CACHE_CHANGED');
      }
      const list: string[] = []; const walk = async (folder: string) => { for (const item of await readdir(folder, { withFileTypes: true })) { const file = path.join(folder, item.name); if (item.isDirectory()) await walk(file); else if (/\.(md|json|ya?ml|txt)$/i.test(file)) list.push(path.relative(target, file).replaceAll('\\', '/')); } }; await walk(target);
      this.roots.set(domain, target); this.files.set(domain, list);
    }
  }
  catalogue() { return Object.entries(domains).map(([domain, spec]) => ({ domain: domain as Domain, title: spec.title, version: spec.version, available: this.roots.has(domain as Domain), sha256: spec.sha256, files: this.files.get(domain as Domain) ?? [] })); }
  folder(domain: Domain) { const folder = this.roots.get(domain); if (!folder) throw new AppError(503, '对应的原始方法包不可用，请按 README 恢复用户提供的输入包。', 'METHOD_UNAVAILABLE'); return folder; }
  async reference(domain: Domain | 'protocol', name: string) {
    invariant(!name.includes('..') && !name.includes('\\') && !path.isAbsolute(name) && /\.(md|json|ya?ml|txt)$/i.test(name), 403, '只能读取登记的方法文件。', 'METHOD_SCOPE');
    if (domain !== 'protocol') { this.folder(domain); invariant(this.files.get(domain)?.includes(name), 404, '方法文件未登记。'); }
    else invariant(['AGENTS.md', 'CORE.md', 'protocol.yaml', 'schemas/task-bundle.schema.json', 'templates/task-bundle.json'].includes(name), 403, '协议文件未开放。');
    if (domain === 'protocol') invariant((await stat(this.protocolRoot).catch(() => null))?.isDirectory(), 503, '原协议私有快照未提供。请按 README 恢复获准的固定版本；公开仓库不会自动下载或替换协议。', 'PROTOCOL_UNAVAILABLE');
    const root = domain === 'protocol' ? this.protocolRoot : this.folder(domain); const file = await ownedFile(root, name); const bytes = await readFile(file);
    return { domain, name, version: domain === 'protocol' ? '0.2-draft' : domains[domain].version, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') };
  }
}
