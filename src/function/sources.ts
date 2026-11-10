import * as cheerio from 'cheerio';
import { z } from 'zod';
import type { Asset, Binding, Json, Matter, Snapshot, Source, SourceKind } from '../../shared/types.js';
import { Store } from '../asset/store.js';
import { Assets } from '../asset/files.js';
import { AppError, invariant, errorText } from '../../server/errors.js';
import { publicUrl, sourceKey, safeRead, type PublicReader } from './network.js';
import { Workers } from './workers.js';

export const SourceInput = z.object({ name: z.string().trim().max(200).default(''), kind: z.enum(['page', 'website', 'rss', 'file']), url: z.string().trim().max(3000).default(''), claimedKind: z.enum(['unknown', 'official', 'company', 'research', 'media', 'other']).default('unknown'), regions: z.string().max(300).default(''), language: z.string().max(80).default(''), notes: z.string().max(2000).default(''), scope: z.enum(['case', 'space']).default('case'), caseId: z.string().uuid().optional(), materialId: z.string().uuid().optional() }).strict();
function decode(data: Buffer, contentType: string | string[] | undefined) { const charset = /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(String(contentType ?? ''))?.[1] ?? /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(data.subarray(0, 3000).toString())?.[1] ?? 'utf-8'; try { return new TextDecoder(charset).decode(data); } catch { return data.toString('utf8'); } }
function linksFrom($: cheerio.CheerioAPI, base: string) { const links: { title: string; url: string }[] = []; $('a[href]').each((_index, element) => { try { const url = publicUrl(new URL($(element).attr('href')!, base).href).href; if (!links.some(link => link.url === url) && links.length < 150) links.push({ title: $(element).text().trim().slice(0, 180) || url, url }); } catch { /* Unsafe links are not candidates. */ } }); return links; }
export class Sources {
  constructor(readonly store: Store, readonly assets: Assets, readonly workers: Workers, readonly readPublic: PublicReader = safeRead) {}
  get(spaceId: string, id: string, caseId?: string) { const source = this.store.get<Source>('source', id); invariant(source.spaceId === spaceId && (!caseId || !source.caseId || source.caseId === caseId), 403, '来源不属于当前主体或事项。', 'SOURCE_SCOPE'); return source; }
  list(spaceId: string, caseId?: string) { return this.store.list<Source>('source', { spaceId }).filter(source => source.lifecycle !== 'removed' && (!caseId || !source.caseId || source.caseId === caseId)); }
  create(spaceId: string, raw: unknown, origin: Source['origin'] = 'user') {
    const input = SourceInput.parse(raw); this.store.get('space', spaceId);
    if (input.caseId) { const matter = this.store.get<Matter>('case', input.caseId); invariant(matter.spaceId === spaceId, 403, '事项不属于此主体。'); }
    invariant(input.scope !== 'case' || input.caseId, 400, '请先创建或选择当前事项。');
    const url = input.kind === 'file' ? '' : publicUrl(input.url).href;
    let file: Asset | undefined;
    if (input.kind === 'file') { invariant(input.materialId, 400, '请先上传文件。'); file = this.store.get<Asset>('asset', input.materialId); invariant(file.spaceId === spaceId && (!file.caseId || file.caseId === input.caseId) && file.availability === 'available' && file.kind === 'upload', 403, '只能选择当前范围已上传的资料。'); }
    const same = this.store.list<Source>('source', { spaceId }).find(source => source.kind === input.kind && (input.kind === 'file' ? source.materialId === input.materialId : sourceKey(source.url) === sourceKey(url)) && source.scope === input.scope && source.caseId === (input.scope === 'case' ? input.caseId : undefined));
    if (same?.lifecycle === 'removed' && origin === 'user') { const restored = this.store.update<Source>('source', same.id, row => { Object.assign(row, input, { caseId: same.caseId, url, lifecycle: 'active', accessStatus: 'not_checked', lastError: undefined, latestSnapshotId: undefined, origin: 'user', publisherStatus: 'user_declared' }); row.descriptorVersion++; }); if (input.caseId) this.bind(spaceId, input.caseId, [{ sourceId: restored.id, descriptorVersion: restored.descriptorVersion }], false); return restored; }
    invariant(!same, 409, '同一范围已登记这个来源；可查看、编辑或恢复已有记录。', 'SOURCE_EXISTS');
    const source = this.store.create<Source>('source', { ...input, spaceId, caseId: input.scope === 'case' ? input.caseId : undefined, name: input.name || file?.name || new URL(url).hostname, url, lifecycle: 'active', descriptorVersion: 1, accessStatus: 'not_checked', origin, publisherStatus: origin === 'catalogue' ? 'catalogue_entry' : 'user_declared', updateMode: 'manual' });
    if (input.caseId) this.bind(spaceId, input.caseId, [{ sourceId: source.id, descriptorVersion: 1 }], false);
    return source;
  }
  edit(spaceId: string, id: string, raw: Json) {
    const source = this.get(spaceId, id); const expected = z.number().int().positive().parse(raw.version);
    const input = SourceInput.parse({ name: source.name, kind: source.kind, url: source.url, claimedKind: source.claimedKind, regions: source.regions, language: source.language, notes: source.notes, scope: source.scope, caseId: source.caseId, materialId: source.materialId, ...Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'version')) });
    invariant(input.kind === source.kind && input.scope === source.scope && (input.scope !== 'case' || input.caseId === source.caseId) && input.materialId === source.materialId, 400, '类型、主体范围和原件不能通过编辑偷偷变更，请另行登记。');
    const url = source.kind === 'file' ? '' : publicUrl(input.url).href;
    return this.store.update<Source>('source', id, row => { Object.assign(row, input, { caseId: source.caseId, url }); row.descriptorVersion++; row.accessStatus = 'not_checked'; row.lastError = undefined; row.latestSnapshotId = undefined; }, expected);
  }
  lifecycle(spaceId: string, id: string, state: Source['lifecycle'], version: number) { this.get(spaceId, id); return this.store.update<Source>('source', id, row => { row.lifecycle = state; }, version); }
  bind(spaceId: string, caseId: string, items: { sourceId: string; descriptorVersion: number }[], replace = true) {
    const matter = this.store.get<Matter>('case', caseId); invariant(matter.spaceId === spaceId, 403, '事项不属于此主体。');
    const sources = items.map(item => { const source = this.get(spaceId, item.sourceId, caseId); invariant(source.lifecycle === 'active' && source.descriptorVersion === item.descriptorVersion, 409, '来源已暂停、移除或版本改变。'); return source; });
    return this.store.transaction(() => {
      if (replace) for (const binding of this.store.list<Binding>('binding', { caseId })) this.store.update<Binding>('binding', binding.id, row => { row.enabled = false; });
      for (const source of sources) { const existing = this.store.list<Binding>('binding', { caseId }).find(binding => binding.sourceId === source.id); if (existing) this.store.update<Binding>('binding', existing.id, row => { row.enabled = true; row.descriptorVersion = source.descriptorVersion; row.snapshotId = source.latestSnapshotId; }); else this.store.create<Binding>('binding', { spaceId, caseId, sourceId: source.id, descriptorVersion: source.descriptorVersion, snapshotId: source.latestSnapshotId, enabled: true }); }
      return this.store.list<Binding>('binding', { caseId }).filter(row => row.enabled);
    });
  }
  selected(matter: Matter) { return this.store.list<Binding>('binding', { caseId: matter.id }).filter(binding => binding.enabled).flatMap(binding => { const source = this.get(matter.spaceId, binding.sourceId, matter.id); return source.lifecycle === 'active' && source.descriptorVersion === binding.descriptorVersion ? [{ source, binding, snapshot: source.latestSnapshotId ? this.store.get<Snapshot>('snapshot', source.latestSnapshotId) : undefined }] : []; }); }
  preview(spaceId: string, id: string, snapshotId?: string, caseId?: string) { const source = this.get(spaceId, id, caseId); invariant(source.lifecycle === 'active', 410, '来源已暂停或移除，不能继续读取正文。'); const target = snapshotId ?? source.latestSnapshotId; invariant(target, 404, '尚未读取来源正文。'); const snapshot = this.store.get<Snapshot>('snapshot', target); invariant(snapshot.sourceId === source.id, 403, '快照不属于此来源。'); return snapshot; }
  async check(spaceId: string, id: string, expectedDescriptor: number, signal?: AbortSignal) {
    const source = this.get(spaceId, id); invariant(source.lifecycle === 'active' && source.descriptorVersion === expectedDescriptor, 409, '来源已暂停、移除或版本变化。');
    this.store.update<Source>('source', id, row => { row.accessStatus = 'checking'; row.lastError = undefined; });
    let title = source.name, text = '', url = source.url, status: Snapshot['status'] = 'readable', partial = false;
    let rawRef: Snapshot['rawRef'], assetRef: Snapshot['assetRef']; let links: Snapshot['links'] = [], attachments: Snapshot['attachments'] = []; let issue: string | undefined; let parserMeta: Json | undefined;
    try {
      if (source.kind === 'file') {
        const original = this.store.get<Asset>('asset', source.materialId!); const data = await this.assets.read(this.assets.ref(original), spaceId, source.caseId); rawRef = this.assets.ref(original);
        const parsed = await this.workers.parse(data.file, signal); text = String(parsed.text ?? ''); partial = !!parsed.partial; parserMeta = parsed.metadata;
        if (parsed.needs_visual) issue = '部分 PDF 页面需要视觉或 OCR 补读，不能声称已读全文。';
        if (!text.trim()) { status = 'unsupported'; issue = '没有可解析正文，请提供可读取的正文或扫描件补读结果。'; }
      } else {
        const response = await this.readPublic(source.url, signal); url = response.url;
        if (response.status === 401) throw new AppError(401, '来源需要登录，未尝试代登录或注册。', 'SOURCE_AUTH_REQUIRED');
        invariant(response.status >= 200 && response.status < 300, 422, `来源返回 HTTP ${response.status}，本轮未能读取正文。`, 'SOURCE_HTTP_ERROR');
        if (response.mime === 'application/pdf') {
          const raw = await this.assets.save(spaceId, source.caseId, '来源原件.pdf', response.data, 'application/pdf', 'source', 'source_raw', [], { sourceId: id, originalUrl: source.url, descriptorVersion: expectedDescriptor }); rawRef = this.assets.ref(raw);
          const parsed = await this.workers.parse((await this.assets.read(rawRef, spaceId, source.caseId)).file, signal); text = parsed.text ?? ''; partial = !!parsed.partial; parserMeta = parsed.metadata; if (parsed.needs_visual) issue = 'PDF 含需视觉补读内容。';
        } else {
          invariant(!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity', 422, '此来源忽略了无压缩读取要求，请通过浏览器或文件提供正文。');
          const html = decode(response.data, response.headers['content-type']); const raw = await this.assets.save(spaceId, source.caseId, '来源原始响应.txt', response.data, 'text/plain', 'source', 'source_raw', [], { sourceId: id, originalUrl: source.url, originalMime: response.mime, descriptorVersion: expectedDescriptor }); rawRef = this.assets.ref(raw);
          if (source.kind === 'rss' || /xml|rss|atom/.test(response.mime)) {
            invariant(!/<!DOCTYPE|<!ENTITY/i.test(html), 400, '订阅源包含不允许的 XML 声明。'); const $ = cheerio.load(html, { xmlMode: true }); const items: string[] = [];
            $('item,entry').slice(0, 100).each((_index, element) => { const item = $(element); const name = item.find('title').first().text().trim(); const rawUrl = item.find('link').first().attr('href') || item.find('link').first().text(); if (rawUrl) try { links.push({ title: name, url: publicUrl(new URL(rawUrl, url).href).href }); } catch { /* Invalid links remain unavailable. */ } items.push(`${name}\n${item.find('description,summary,content').first().text().slice(0, 4000)}`); });
            title = $('channel>title,feed>title').first().text().trim() || title; text = items.join('\n\n'); partial = true; issue = '订阅条目是发现线索；具体详情与资格需另读原文。';
          } else if (/text\/plain|text\/markdown/.test(response.mime)) text = html;
          else {
            const $ = cheerio.load(html); title = $('title').first().text().trim().slice(0, 240) || title; links = linksFrom($, url); attachments = links.filter(link => /\.(pdf|docx?|xlsx?|zip)(?:\?|$)/i.test(link.url));
            if ($('input[type=password]').length && $('body').text().length < 2500) throw new AppError(401, '页面要求登录，未读取私有内容。', 'SOURCE_AUTH_REQUIRED');
            const scripts = $('script').length; $('script,style,noscript,nav,footer,header,iframe,object,form').remove();
            const article = $('article,main,.TRS_Editor,.article-content,.content-body').first(); const target = article.length ? article : $('body'); target.find('p,div,li,tr,h1,h2,h3,br').each((_i, item) => { $(item).append('\n'); }); text = target.text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
            if ((text.length < 100 && scripts > 0 && (!article.length || text.length < 10)) || (new URL(url).hash.startsWith('#/') && scripts > 0 && !article.length)) { status = 'needs_browser'; issue = '页面依赖脚本或页内路由，需要浏览器／人工补读；原路由已保留。'; }
            if (attachments.length) partial = true;
          }
        }
      }
      signal?.throwIfAborted();
      if (text.length > 300000) { text = text.slice(0, 300000); partial = true; issue = '正文超过读取预算，已明确截断，不能视为完整覆盖。'; }
      if (!text.trim() && status === 'readable') { status = 'unsupported'; issue = '未识别到可用正文。'; }
      if (text) { const asset = await this.assets.save(spaceId, source.caseId, `${title || '来源'}-已读正文.txt`, text, 'text/plain', 'derived', 'source_text', rawRef ? [rawRef] : [], { sourceId: id, accessScope: partial ? 'partial' : 'body', url, descriptorVersion: expectedDescriptor }); assetRef = this.assets.ref(asset); }
      const snapshot = this.store.create<Snapshot>('snapshot', { spaceId, caseId: source.caseId, sourceId: id, descriptorVersion: expectedDescriptor, title, text, status, evidenceStage: status !== 'readable' ? 'lead' : partial ? 'partial' : 'body_read', checkedAt: new Date().toISOString(), url, rawRef, assetRef, links, attachments, truncated: partial, error: issue, parserMeta });
      const current = this.get(spaceId, id); if (current.descriptorVersion === expectedDescriptor && current.lifecycle === 'active') this.store.update<Source>('source', id, row => { row.accessStatus = status; row.lastCheckedAt = snapshot.checkedAt; row.lastError = issue; row.latestSnapshotId = snapshot.id; });
      return snapshot;
    } catch (error) {
      const state = error instanceof AppError && error.code === 'SOURCE_AUTH_REQUIRED' ? 'needs_auth' : 'failed'; const message = signal?.aborted ? '本轮读取已中断，不能视为已复核。' : errorText(error);
      const current = this.get(spaceId, id); if (current.descriptorVersion === expectedDescriptor) this.store.update<Source>('source', id, row => { row.accessStatus = state; row.lastCheckedAt = new Date().toISOString(); row.lastError = message; });
      throw new AppError(error instanceof AppError ? error.status : 502, message, error instanceof AppError ? error.code : 'SOURCE_READ_FAILED');
    }
  }
}
