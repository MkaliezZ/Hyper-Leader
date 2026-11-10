import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, AssetRef, Json, Matter } from '../../shared/types.js';
import { Store } from './store.js';
import { ownedFile } from '../../server/files.js';
import { invariant } from '../../server/errors.js';

export class Assets {
  constructor(readonly store: Store) {}
  async save(spaceId: string, caseId: string | undefined, name: string, data: Buffer | string, mime: string, nature: Asset['nature'], kind: string, derivedFrom: AssetRef[] = [], meta: Json = {}) {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const extension = path.extname(name).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12) || '.bin';
    const directory = path.join('assets', spaceId); await mkdir(path.join(this.store.home, directory), { recursive: true, mode: 0o700 });
    const relative = path.join(directory, `${randomUUID()}${extension}`); const file = path.join(this.store.home, relative);
    await writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
    try { return this.store.create<Asset>('asset', { spaceId, caseId, name: path.basename(name).slice(0, 200), kind, mime, path: relative, sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length, refVersion: '1', nature, availability: 'available', derivedFrom, meta }); }
    catch (e) { await unlink(file).catch(() => undefined); throw e; }
  }
  ref(asset: Asset): AssetRef { return { asset_id: asset.id, version: asset.refVersion }; }
  get(reference: AssetRef, spaceId: string, caseId?: string): Asset { const asset = this.store.get<Asset>('asset', reference.asset_id); invariant(asset.spaceId === spaceId && (!caseId || !asset.caseId || asset.caseId === caseId), 403, '资料不属于当前主体或事项。', 'ASSET_SCOPE'); invariant(asset.refVersion === reference.version, 409, '资产版本不匹配。', 'VERSION_MISMATCH'); invariant(asset.availability === 'available', 410, '资料已撤回或清除。', 'ASSET_UNAVAILABLE'); return asset; }
  async read(reference: AssetRef, spaceId: string, caseId?: string) { const asset = this.get(reference, spaceId, caseId); const file = await ownedFile(this.store.home, asset.path); const data = await readFile(file); invariant(createHash('sha256').update(data).digest('hex') === asset.sha256, 409, '文件内容已改变，不能继续使用旧版本。', 'ASSET_CHANGED'); return { asset, data, file }; }
  async remove(asset: Asset) { const file = await ownedFile(this.store.home, asset.path).catch(() => null); if (file) await unlink(file); this.store.update<Asset>('asset', asset.id, row => { row.availability = 'deleted'; }); }
  forCase(matter: Matter) { return this.store.list<Asset>('asset', { spaceId: matter.spaceId }).filter(a => (!a.caseId || a.caseId === matter.id) && a.availability === 'available'); }
  public(asset: Asset) { const { path: _path, ...values } = asset; return values; }
}
