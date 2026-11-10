import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import type { Action, Artifact, Asset, AssetRef, Binding, Context, Domain, Intent, Json, Matter, Message, Run, Snapshot, Source, Space, Tracking } from '../../shared/types.js';
import { domainLabels } from '../../shared/types.js';
import { Config } from '../../server/config.js';
import { AppError, invariant } from '../../server/errors.js';
import { Assets } from '../asset/files.js';
import { Store } from '../asset/store.js';
import { domains, emptyReviews, escapeHtml, selectedDomains } from '../judgment/policy.js';
import { Skills } from './skills.js';
import { Workers, rejectLocalReferences } from './workers.js';
import { Sources } from './sources.js';
import { Jobs } from './jobs.js';
import { safeRead, type PublicReader } from './network.js';

const Ref = z.object({ asset_id: z.string().uuid(), version: z.string().min(1) }).strict();
const SpaceInput = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['company', 'person', 'family']).default('company'), profile: z.string().max(20000).default('') }).strict();
const IntentInput = z.enum(['general', 'market', 'enterprise', 'domestic', 'international']);
const CaseInput = z.object({ title: z.string().trim().min(1).max(160), goal: z.string().max(4000).default(''), intent: IntentInput.default('general') }).strict();
const ArtifactInput = z.object({ title: z.string().trim().min(1).max(200), kind: z.string().max(80).default('analysis'), summary: z.string().max(2000).default(''), content: z.string().min(1).max(500000), evidence_refs: z.array(Ref).max(200).default([]), domain: z.enum(['market', 'enterprise', 'domestic', 'international']).optional(), artifact_id: z.string().uuid().optional(), expected_version: z.number().int().positive().optional() }).strict();

export class Leader {
  readonly assets: Assets; readonly skills: Skills; readonly workers: Workers; readonly sources: Sources; readonly jobs: Jobs;
  constructor(readonly config: Config, readonly store: Store, reader?: PublicReader) { this.assets = new Assets(store); this.skills = new Skills(config.root, config.home); this.workers = new Workers(config, this.skills); this.sources = new Sources(store, this.assets, this.workers, reader); this.jobs = new Jobs(store); }
  async init() { await this.skills.init(); }
  space(id: string) { return this.store.get<Space>('space', id); }
  matter(spaceId: string, caseId: string) { const row = this.store.get<Matter>('case', caseId); invariant(row.spaceId === spaceId, 403, '事项不属于当前主体。', 'CASE_SCOPE'); return row; }
  createSpace(raw: unknown) { const input = SpaceInput.parse(raw); return this.store.create<Space>('space', input); }
  updateSpace(id: string, raw: Json) { const input = SpaceInput.parse({ name: raw.name, kind: raw.kind, profile: raw.profile }); return this.store.update<Space>('space', id, row => Object.assign(row, input), z.number().int().positive().parse(raw.version)); }
  createCase(spaceId: string, raw: unknown) { this.space(spaceId); const input = CaseInput.parse(raw); return this.store.create<Matter>('case', { ...input, spaceId, sessionId: crypto.randomUUID(), runtimeStarted: false }); }
  assertEvidence(matter: Matter, reference: AssetRef, visited = new Set<string>()) {
    if (visited.has(reference.asset_id)) return; invariant(visited.size < 300, 400, '引用链超过限制。'); visited.add(reference.asset_id);
    const asset = this.assets.get(reference, matter.spaceId, matter.id);
    const sourceId = asset.meta.sourceId ?? (asset.kind === 'upload' ? this.store.list<Source>('source', { spaceId: matter.spaceId }).filter(source => source.materialId === asset.id && (!source.caseId || source.caseId === matter.id)).sort((a, b) => Number(!!b.caseId) - Number(!!a.caseId))[0]?.id : undefined);
    if (sourceId) { const source = this.sources.get(matter.spaceId, sourceId, matter.id); invariant(source.lifecycle === 'active', 410, '引用来源已暂停或移除，请更新资料范围。', 'SOURCE_REVOKED'); invariant(asset.meta.descriptorVersion === undefined || asset.meta.descriptorVersion === source.descriptorVersion, 410, '引用正文属于旧来源描述版本，请重新读取当前版本。', 'SOURCE_VERSION_CHANGED'); const binding = this.store.list<Binding>('binding', { caseId: matter.id }).find(row => row.sourceId === source.id); if (binding) invariant(binding.enabled && binding.descriptorVersion === source.descriptorVersion, 410, '来源未在本轮采用或版本已变化。', 'SOURCE_NOT_SELECTED'); }
    for (const parent of asset.derivedFrom) this.assertEvidence(matter, parent, visited);
  }
  async context(spaceId: string, caseId: string, model = false): Promise<Context> {
    const space = this.space(spaceId), matter = this.matter(spaceId, caseId); const selected = this.sources.selected(matter);
    const profileRun = [...this.store.list<Run>('run', { caseId })].reverse().find(run => run.limits.profileVersion === space.version && run.limits.profileSourceRef); if (profileRun) (space as any).profileSourceRef = profileRun.limits.profileSourceRef;
    const sources = this.sources.list(spaceId, caseId).map(source => ({ ...source, selected: selected.some(row => row.source.id === source.id), snapshot: source.latestSnapshotId ? this.store.get<Snapshot>('snapshot', source.latestSnapshotId) : undefined }));
    const inputRefs: AssetRef[] = [];
    const artifacts = this.store.list<Artifact>('artifact', { caseId }).map(artifact => { if (model) try { this.assertEvidence(matter, artifact.mdRef); artifact.evidenceRefs.forEach(ref => this.assertEvidence(matter, ref)); inputRefs.push(artifact.mdRef, ...artifact.evidenceRefs); } catch { return { ...artifact, title: '[历史成果：本轮不可读取]', content: '[来源范围已变化，本轮不自动读取旧内容。]', summary: '需要重新核对资料范围' }; } return artifact; });
    const materials = this.assets.forCase(matter).filter(asset => { if (asset.kind !== 'upload') return false; if (!model) return true; const source = this.store.list<Source>('source', { spaceId }).find(item => item.materialId === asset.id && (!item.caseId || item.caseId === caseId)); if (!source) return true; const binding = this.store.list<Binding>('binding', { caseId }).find(item => item.sourceId === source.id); return source.lifecycle === 'active' && (!binding || (binding.enabled && binding.descriptorVersion === source.descriptorVersion)); }).map(asset => this.assets.public(asset) as Asset);
    const messages = this.store.list<Message>('message', { caseId }).map(message => { if (model && message.role === 'assistant') return { ...message, content: '[历史助手回复不自动作为新事实；请使用当前有效成果及证据。]' }; return message; });
    const actions = this.store.list<Action>('action', { caseId }).map(action => { if (model) try { const refs = [...action.evidenceRefs, ...(action.dependencyRefs ?? [])]; refs.forEach(reference => this.assertEvidence(matter, reference)); inputRefs.push(...refs); } catch { return { ...action, title: '[历史行动：本轮不可读取]', owner: '', due: '', acceptance: '', feedback: '' }; } return action; });
    const allowedSources = model ? sources.filter(source => source.selected).map(source => ({ ...source, snapshot: source.snapshot ? { ...source.snapshot, text: source.snapshot.text.slice(0, 80000) } : undefined })) : sources;
    if (model) { for (const source of allowedSources) if (source.snapshot?.assetRef) { this.assertEvidence(matter, source.snapshot.assetRef); inputRefs.push(source.snapshot.assetRef); } for (const message of messages) if (message.role === 'user' && message.sourceRef) inputRefs.push(message.sourceRef); }
    const runs = this.store.list<Run>('run', { caseId }).slice(-30).map(run => model ? { ...run, prompt: undefined, question: undefined, error: undefined } : run);
    return { space, matter, messages, sources: allowedSources, materials, artifacts, actions, runs, ...(model ? { inputRefs: inputRefs.filter((reference, index, all) => all.findIndex(item => item.asset_id === reference.asset_id && item.version === reference.version) === index) } : {}), methods: this.skills.catalogue() };
  }
  async upload(spaceId: string, caseId: string | undefined, name: string, bytes: Buffer, raw: Json) {
    this.space(spaceId); if (caseId) this.matter(spaceId, caseId);
    invariant(bytes.length <= 20 * 1024 * 1024, 413, '单份资料不超过20 MiB。');
    const extension = path.extname(name).toLowerCase(); invariant(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md'].includes(extension), 415, '当前支持 PDF、DOCX、XLSX、CSV、TXT、MD。其他资料请先提供获准的可读正文。', 'FILE_TYPE');
    const mime: Record<string, string> = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown' };
    const asset = await this.assets.save(spaceId, raw.scope === 'space' ? undefined : caseId, name, bytes, mime[extension], 'source', 'upload', [], { declaration: 'user_supplied_not_independently_verified' });
    const source = this.sources.create(spaceId, { name: raw.name || name, kind: 'file', materialId: asset.id, caseId, scope: raw.scope === 'space' ? 'space' : 'case', claimedKind: raw.claimedKind || 'unknown', regions: raw.regions || '', language: raw.language || '', notes: raw.notes || '用户提供的原件；保存不等于已读或已核验。' });
    return { asset: this.assets.public(asset), source };
  }
  checkSource(spaceId: string, sourceId: string, descriptorVersion: number) {
    const source = this.sources.get(spaceId, sourceId);
    const existing = this.store.list<Run>('run', { spaceId }).find(run => run.sourceId === sourceId && run.status === 'running'); if (existing) return existing;
    const run = this.jobs.create(spaceId, source.caseId, 'source_check', '用户选择检查／刷新来源；只在登记范围只读，不注册、付费或自动订阅。', { sourceId });
    return this.jobs.start(run, async signal => { this.jobs.event(run.id, 'gather_evidence', '正在读取来源正文与范围'); const snapshot = await this.sources.check(spaceId, sourceId, descriptorVersion, signal); this.store.update<Run>('run', run.id, row => { row.evidenceRefs = [snapshot.assetRef, snapshot.rawRef].filter(Boolean) as AssetRef[]; row.limits = { sourceStatus: snapshot.status, evidenceStage: snapshot.evidenceStage, descriptorVersion }; }); });
  }
  sourceLifecycle(spaceId: string, sourceId: string, lifecycle: Source['lifecycle'], version: number) { const result = this.sources.lifecycle(spaceId, sourceId, lifecycle, version); if (lifecycle !== 'active') { this.cancelSourceRuns(spaceId, sourceId); for (const tracking of this.store.list<Tracking>('tracking', { spaceId }).filter(row => row.sourceIds.includes(sourceId))) this.store.update<Tracking>('tracking', tracking.id, row => { row.enabled = false; row.lastResult = '相关来源已暂停或移除。'; }); } return result; }
  cancelSourceRuns(spaceId: string, sourceId: string) { const cases = new Set(this.store.list<Binding>('binding', { spaceId }).filter(row => row.sourceId === sourceId).map(row => row.caseId)); for (const run of this.store.list<Run>('run', { spaceId }).filter(row => row.status === 'running' && (row.sourceId === sourceId || (row.kind === 'analysis' && row.caseId && cases.has(row.caseId))))) void this.jobs.cancel(run.id); }
  contextFence(matter: Matter) { const bindings = this.store.list<Binding>('binding', { caseId: matter.id }).map(binding => { const source = this.sources.get(matter.spaceId, binding.sourceId, matter.id); const snapshot = source.latestSnapshotId ? this.store.get<Snapshot>('snapshot', source.latestSnapshotId) : undefined; const hash = snapshot?.assetRef ? this.store.get<Asset>('asset', snapshot.assetRef.asset_id).sha256 : null; return { id: source.id, enabled: binding.enabled, bound: binding.descriptorVersion, current: source.descriptorVersion, lifecycle: source.lifecycle, contentHash: hash }; }); const uploads = this.assets.forCase(matter).filter(asset => asset.kind === 'upload').map(asset => [asset.id, asset.refVersion, asset.availability]); return JSON.stringify({ runtimeContract: '0.1.0-transitive-input-dependencies.1', profileVersion: this.space(matter.spaceId).version, bindings, uploads }); }
  async saveArtifact(spaceId: string, caseId: string, raw: unknown, runId?: string, extras: { name: string; data: Buffer; mime: string }[] = []) {
    const matter = this.matter(spaceId, caseId), input = ArtifactInput.parse(raw); input.evidence_refs.forEach(reference => this.assertEvidence(matter, reference));
    const previous = input.artifact_id ? this.store.get<Artifact>('artifact', input.artifact_id) : undefined;
    if (previous) { invariant(previous.spaceId === spaceId && previous.caseId === caseId, 403, '成果不属于当前事项。'); invariant(input.expected_version === previous.version, 409, '成果版本已变化，请重新读取上下文。'); }
    const contentVersion = ((previous as any)?.contentVersion ?? 0) + 1;
    const observedInputs = runId ? this.store.get<Run>('run', runId).evidenceRefs : [];
    const dependencies = [...input.evidence_refs, ...observedInputs].filter((reference, index, all) => all.findIndex(item => item.asset_id === reference.asset_id && item.version === reference.version) === index);
    dependencies.forEach(reference => this.assertEvidence(matter, reference));
    const md = await this.assets.save(spaceId, caseId, `${input.title}-v${contentVersion}.md`, input.content, 'text/markdown', 'model_observation', 'report', dependencies, { runId, dependencyScope: '输入上下文依赖；不表示每个输入都支持每条业务主张。' });
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)}</title><style>body{font:16px/1.8 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:24px;color:#172d35;background:#fafbf9}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}header{border-bottom:1px solid #dae1df}small{color:#687a7f}@media print{body{margin:0}}</style><header><small>Hyper Leader · 分析草稿 · 待评议 · 内容版本 ${contentVersion}</small><h1>${escapeHtml(input.title)}</h1></header><pre>${escapeHtml(input.content)}</pre></html>`;
    const web = await this.assets.save(spaceId, caseId, `${input.title}-v${contentVersion}.html`, html, 'text/html', 'derived', 'report', [this.assets.ref(md)], { runId });
    const extraRefs: AssetRef[] = [];
    for (const file of extras) { const asset = await this.assets.save(spaceId, caseId, file.name, file.data, file.mime, 'derived', 'domain_export', dependencies, { runId, domain: input.domain }); extraRefs.push(this.assets.ref(asset)); }
    const receipt = await this.assets.save(spaceId, caseId, 'report-write-receipt.json', JSON.stringify({ scope: 'Actual report files saved; not semantic, aesthetic, human or real-world acceptance', at: new Date().toISOString(), files: [md, web].map(asset => ({ asset_id: asset.id, version: asset.refVersion, sha256: asset.sha256 })), extraRefs }), 'application/json', 'run_log', 'receipt', [this.assets.ref(md), this.assets.ref(web)]);
    const reviews = emptyReviews() as Artifact['reviews']; reviews.engineering = { status: 'passed', scope: '本次本机文件已保存、输入已转义并保留版本和指纹；不证明内容正确或人工认可。', evidence_refs: [this.assets.ref(receipt)], reviewer_kind: 'code', reason: '实际写入完成。' };
    const data = { spaceId, caseId, title: input.title, kind: input.kind, summary: input.summary, content: input.content, mdRef: this.assets.ref(md), htmlRef: this.assets.ref(web), extraRefs: [...extraRefs, this.assets.ref(receipt)], evidenceRefs: input.evidence_refs, domain: input.domain, judgmentStatus: 'needs_review' as const, reviews, runId, contentVersion };
    dependencies.forEach(reference => this.assertEvidence(matter, reference));
    if (runId) invariant(this.store.get<Run>('run', runId).status === 'running', 409, '本轮已停止，未将尚在写入的文件登记为完成报告。', 'RUN_STOPPED');
    const artifact = previous ? this.store.update<Artifact>('artifact', previous.id, row => Object.assign(row, data), input.expected_version) : this.store.create<Artifact>('artifact', data);
    if (runId) this.store.update<Run>('run', runId, row => { row.artifactIds.push(artifact.id); }); return artifact;
  }
  async acceptArtifact(spaceId: string, caseId: string, id: string, version: number) { const matter = this.matter(spaceId, caseId); const artifact = this.store.get<Artifact>('artifact', id); invariant(artifact.spaceId === spaceId && artifact.caseId === caseId, 403, '成果不属于当前事项。'); artifact.evidenceRefs.forEach(reference => this.assertEvidence(matter, reference)); const evidence = await this.assets.save(spaceId, caseId, '人工确认记录.json', JSON.stringify({ actor: 'local_user', action: 'explicit_acceptance_click', artifactId: id, artifactRecordVersion: version, contentVersion: (artifact as any).contentVersion, at: new Date().toISOString(), scope: '仅确认该版本内容，不证明专业审定或现实效果。' }), 'application/json', 'source', 'human_acceptance', [artifact.mdRef]); return this.store.update<Artifact>('artifact', id, row => { row.reviews.human_acceptance = { status: 'passed', scope: '本机用户明确确认此内容版本；不是专业审定或现实效果认证。', evidence_refs: [this.assets.ref(evidence)], reviewer_kind: 'human', reason: '用户在界面主动点击确认。' }; }, version); }
  async evaluate(spaceId: string, caseId: string, domain: Domain, operation: string, data: unknown, title: string, evidenceRefs: AssetRef[], runId?: string, signal?: AbortSignal) {
    const matter = this.matter(spaceId, caseId); evidenceRefs.forEach(ref => this.assertEvidence(matter, ref)); rejectLocalReferences(data);
    const bound = structuredClone(data) as any; const allowedLocalUris: string[] = []; const bindingRefs: AssetRef[] = [];
    if (domain === 'market' && Array.isArray(bound?.sources)) for (const source of bound.sources) if (source.asset_ref) {
      const reference = Ref.parse(source.asset_ref); this.assertEvidence(matter, reference); const original = await this.assets.read(reference, spaceId, caseId);
      const registered = this.sources.list(spaceId, caseId).find(item => item.materialId === original.asset.id && item.lifecycle === 'active'); invariant(registered?.latestSnapshotId, 400, '本地来源须先实际读取正文，不能只登记文件。', 'LOCAL_SOURCE_NOT_READ');
      const snapshot = this.sources.preview(spaceId, registered.id, undefined, caseId); invariant(snapshot.status === 'readable' && snapshot.assetRef, 400, '本地来源没有可用的已读正文。'); this.assertEvidence(matter, snapshot.assetRef);
      if (runId) invariant(this.store.get<Run>('run', runId).evidenceRefs.some(item => item.asset_id === snapshot.assetRef!.asset_id), 400, '请先调用 leader_read_material 获取本地来源实际正文和定位。');
      source.url = pathToFileURL(original.file).href; source.sha256 = original.asset.sha256; source.media_type = original.asset.mime; source.version = `asset:${reference.asset_id}@${reference.version}`;
      if (source.access_status === 'full_text' && snapshot.evidenceStage !== 'body_read') source.access_status = 'partial';
      if (original.asset.mime === 'application/pdf') { source.page_count = snapshot.parserMeta?.page_count; source.page_count_method = 'pypdf'; }
      delete source.asset_ref; allowedLocalUris.push(source.url); bindingRefs.push(reference, snapshot.assetRef);
    }
    const combined = [...evidenceRefs, ...bindingRefs].filter((reference, index, all) => all.findIndex(item => item.asset_id === reference.asset_id && item.version === reference.version) === index);
    if (domain === 'enterprise') {
      const boundSources = new Set<string>();
      for (const reference of combined) { const asset = this.assets.get(reference, spaceId, caseId); boundSources.add(asset.id); boundSources.add(`asset:${asset.id}@${asset.refVersion}`); boundSources.add(`hyper-leader://assets/${asset.id}/versions/${asset.refVersion}`); if (typeof asset.meta.url === 'string') boundSources.add(asset.meta.url); }
      for (const fact of Object.values(bound?.profile?.facts ?? {}) as any[]) if (fact && !boundSources.has(String(fact.source ?? ''))) { fact.declared_status = fact.status ?? null; fact.status = 'unknown'; fact.evidence_binding = 'No actual allowed asset reference was supplied; declared values remain provisional.'; }
      for (const policy of Array.isArray(bound?.policies) ? bound.policies : []) if (!boundSources.has(String(policy.url ?? ''))) { policy.declared_review_state = policy.review_state ?? null; policy.review_state = 'partial'; policy.unresolved_requirements = [...(Array.isArray(policy.unresolved_requirements) ? policy.unresolved_requirements : []), '政策原文尚未绑定本轮实际证据，不能据声明认定已复核。']; }
    }
    const methodName = domain === 'market' ? 'references/data-contract.md' : domain === 'enterprise' ? 'references/matching.md' : domain === 'domestic' ? 'references/job-report-delivery.md' : 'references/data-contract.md';
    const method = await this.skills.reference(domain, methodName); const methodAsset = await this.assets.save(spaceId, caseId, `${domain}-operation-contract.md`, method.text, 'text/plain', 'method', 'method', [], { domain, methodVersion: method.version, sourceSha256: method.sha256, name: methodName, operation, runId });
    if (runId) this.store.update<Run>('run', runId, row => { row.evidenceRefs.push(this.assets.ref(methodAsset)); });
    const output = await this.workers.domain(spaceId, caseId, domain, operation, bound, signal, allowedLocalUris);
    const markdown = output.files.find(file => file.mime === 'text/markdown');
    const content = markdown ? markdown.data.toString('utf8') : `# ${title}\n\n以下为已登记 ${domains[domain].title} 工具的实际结构化结果，仍需按原文及业务范围评议。\n\n\`\`\`json\n${JSON.stringify(output.result, null, 2)}\n\`\`\`\n\n## 原始评估输入\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    return this.saveArtifact(spaceId, caseId, { title, content, kind: 'domain_report', domain, summary: '领域工具执行完成；业务判断与用户确认分别记录。', evidence_refs: [...combined, this.assets.ref(methodAsset)] }, runId, output.files);
  }
  createAction(spaceId: string, caseId: string, raw: unknown, runId?: string) { const matter = this.matter(spaceId, caseId); const input = z.object({ title: z.string().trim().min(1).max(300), owner: z.string().max(100).default('待指定'), due: z.string().max(80).default(''), acceptance: z.string().max(3000).default(''), evidenceRefs: z.array(Ref).default([]) }).strict().parse(raw); const dependencyRefs = runId ? this.store.get<Run>('run', runId).evidenceRefs : []; [...input.evidenceRefs, ...dependencyRefs].forEach(ref => this.assertEvidence(matter, ref)); return this.store.create<Action>('action', { ...input, dependencyRefs, spaceId, caseId, status: 'todo', feedback: '' }); }
  updateAction(spaceId: string, caseId: string, id: string, raw: Json) { const action = this.store.get<Action>('action', id); invariant(action.spaceId === spaceId && action.caseId === caseId, 403, '任务不属于当前事项。'); const input = z.object({ version: z.number().int().positive(), title: z.string().trim().min(1).max(300), owner: z.string().max(100), due: z.string().max(80), acceptance: z.string().max(3000), status: z.enum(['todo', 'doing', 'review', 'done', 'paused']), feedback: z.string().max(6000) }).strict().parse(raw); invariant(input.status !== 'done' || input.feedback.trim(), 400, '完成任务时请记录实际交付或反馈；不能只改状态。'); return this.store.update<Action>('action', id, row => { const { version: _version, ...values } = input; Object.assign(row, values); }, input.version); }
  async discover(matter: Matter, query: string, signal?: AbortSignal) {
    invariant(query.trim() && query.length <= 300, 400, '搜索词应简短且不包含私人材料全文。');
    const catalogue = [
      ['中国政府网政策', 'https://www.gov.cn/zhengce/'], ['全国地方政府目录', 'https://www.gov.cn/home/2023-03/29/content_5748954.htm'], ['中国政府采购网', 'https://www.ccgp.gov.cn/'],
      ['美国资助机会', 'https://www.grants.gov/'], ['美国采购机会', 'https://sam.gov/'], ['欧盟资助入口', 'https://commission.europa.eu/funding-tenders/find-funding_en'], ['欧盟采购 TED', 'https://ted.europa.eu/en/'], ['英国政府资助', 'https://www.find-government-grants.service.gov.uk/'], ['新加坡企业支持', 'https://grants.gobusiness.gov.sg/'], ['世界银行项目采购', 'https://projects.worldbank.org/en/projects-operations/opportunities'], ['WIPO 专利文献', 'https://www.wipo.int/en/web/patentscope'],
    ].map(([title, url]) => ({ title, url, nature: 'official_directory_lead_not_verified_current_opportunity' }));
    const registered = this.sources.list(matter.spaceId, matter.id).filter(source => `${source.name} ${source.notes} ${source.regions}`.toLowerCase().includes(query.toLowerCase()));
    const settings = await this.config.public(); if (settings.searchProvider === 'none') return { catalogue, registered, webSearch: 'not_configured', gap: '尚未启用公网搜索；以上只是登记来源和官方入口，不是全网检索结果。可以直接读取用户链接或在设置启用公开搜索。' };
    const response = await this.sources.readPublic(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, signal); invariant(response.status === 200, 502, '公开搜索页面不可用，登记来源与其他读取仍可继续。'); const xml = response.data.toString('utf8'); invariant(!/<!DOCTYPE|<!ENTITY/i.test(xml), 400, '搜索响应包含不允许的 XML 声明。'); const $ = cheerio.load(xml, { xmlMode: true }); const items: Json[] = []; $('item').slice(0, 15).each((_index, row) => { items.push({ title: $(row).find('title').text(), url: $(row).find('link').text(), snippet: $(row).find('description').text(), nature: 'search_lead_not_full_text' }); });
    return { items, catalogue, registered, provider: 'Bing公开RSS页面（非稳定性承诺的开发者API）', query, checkedAt: new Date().toISOString(), scope: '本次公开页面返回的前15项线索；不证明市场完整或资格。' };
  }
}
