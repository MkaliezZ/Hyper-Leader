import type { Artifact, Asset, AssetRef, Matter, Run } from '../../shared/types.js';
import { domains, PROTOCOL_VERSION } from '../judgment/policy.js';
import { Leader } from './service.js';
export async function taskBundle(leader: Leader, spaceId: string, caseId: string) {
  const core = await leader.skills.reference('protocol', 'CORE.md');
  let coreAsset = leader.store.list<Asset>('asset', { spaceId, caseId }).find(asset => asset.nature === 'method' && asset.meta.domain === 'protocol' && asset.meta.sourceSha256 === core.sha256);
  if (!coreAsset) coreAsset = await leader.assets.save(spaceId, caseId, 'Hyper-Protocol-CORE.md', core.text, 'text/plain', 'method', 'method', [], { domain: 'protocol', methodVersion: '0.2-draft', sourceSha256: core.sha256, name: 'CORE.md' });
  const bundle: any = await baseTaskBundle(leader, spaceId, caseId);
  const records = leader.assets.forCase(leader.matter(spaceId, caseId));
  const policy = (id: string, version: string, title: string, sourceAssets: Asset[]) => ({
    policy_id: id, version, status: 'draft', adoption: 'selected_for_task', maintainer: null,
    selection_basis: '用户要求遵从Hyper Protocol；本事项实际读取／调用的文本方法按原始版本和指纹绑定。此记录不自动将草案升为active。',
    scope: { subjects: [leader.space(spaceId).name], tasks: [leader.matter(spaceId, caseId).title], conditions: ['仅在本事项及原方法适用范围内'], exclusions: ['超出实际权限、专业证据或来源支持的结论'] },
    goals: [title], priorities: ['原始方法、证据、硬条件和真实范围优先；未知及反证保留'], rules: [], quality_dimensions: [], preferences: [],
    decision_authority: { automated_scope: ['本事项已授权的只读研究、确定性检查和草稿保存'], reserved_decisions: ['人工认可', '现实效果认定', '外部提交及新增资料用途另需授权'] },
    revisions: ['0.1.0：按源文本绑定；不编造逐条门槛已通过或完整机器规则形式化'],
    extensions: { hyper_leader: { representation: 'textual-source-binding', source_asset_refs: sourceAssets.map(asset => leader.assets.ref(asset)), source_versions: sourceAssets.map(asset => ({ name: asset.meta.name, upstream_version: asset.meta.methodVersion, sha256: asset.meta.sourceSha256 })), full_machine_gate_formalization: false } },
  });
  const policies: any[] = [policy('hyper-protocol.core', PROTOCOL_VERSION, '原协议三层、权限、证据、版本及分项评议', [coreAsset])];
  for (const [domain, spec] of Object.entries(domains)) { const methods = records.filter(asset => asset.nature === 'method' && asset.meta.domain === domain); if (methods.length) policies.push(policy(`hyper-leader.${domain}.source-bound`, `${spec.version}+binding.0.1`, spec.title, methods)); }
  const coreRef = { id: policies[0].policy_id, version: policies[0].version };
  const refsFor = (domain?: string) => policies.filter(item => item.policy_id === 'hyper-protocol.core' || !domain || item.policy_id === `hyper-leader.${domain}.source-bound`).map(item => ({ id: item.policy_id, version: item.version }));
  bundle.policy_packs = policies;
  for (const run of bundle.runs) run.policy_refs = [coreRef];
  for (const decision of bundle.decisions) decision.policy_refs = refsFor(decision.extensions.hyper_leader.domain ?? undefined);
  bundle.extensions.hyper_leader.limitations = '实际方法文本、源版本和指纹已绑定；未假装完成所有领域门槛的机器形式化，业务判断仍待评议。';
  return bundle;
}

async function baseTaskBundle(leader: Leader, spaceId: string, caseId: string) {
  const matter = leader.matter(spaceId, caseId); const records = leader.assets.forCase(matter); const artifacts = leader.store.list<Artifact>('artifact', { caseId }); const runs = leader.store.list<Run>('run', { caseId });
  const ids = new Set(records.map(asset => asset.id));
  const validRefs = (refs: AssetRef[]) => refs.filter(ref => ids.has(ref.asset_id));
  const assets: any[] = records.map(asset => ({ asset_id: asset.id, version: asset.refVersion, asset_type: asset.kind, nature: asset.nature, source: asset.meta.originalUrl ?? asset.meta.url ?? 'Hyper Leader 当前主体／事项的实际资料或工具输出', locator: `hyper-leader://assets/${asset.id}/versions/${asset.refVersion}`, sha256: asset.sha256, subject_scope: `space:${spaceId}; case:${asset.caseId ?? 'shared-by-user'}`, usage_scope: '当前授权主体与事项；引用不增加访问权，导出不自动许可公开。', availability: asset.availability, snapshot_at: new Date().toISOString(), derived_from: validRefs(asset.derivedFrom), content: null, extensions: { hyper_leader: { ...asset.meta, name: asset.name, mime: asset.mime, record_version: asset.version } } }));
  const capabilities = runs.map(run => ({ capability_id: `hyper-leader.run.${run.id}`, version: '0.1.0', action: run.kind, inputs: ['当前事项请求与允许的资产版本'], outputs: ['运行记录和实际保存产物'], preconditions: ['已核当前主体、任务与输入权限'], policy_refs: [], authorization: { status: 'granted', basis: run.authority, scope: [run.kind], checked_at: run.startedAt ?? run.createdAt }, side_effects: ['当前事项资料与产物保存'], implementation: run.kind === 'analysis' ? 'Official DeepSeek Harness SDK with hyper-leader-only tools' : 'Hyper Leader scoped read/check service', limits: ['工程执行不证明专业、审美、人工或现实效果'], failure_and_recovery: '保留失败／中断和已存资料，恢复时重新核授权与版本。', completion_conditions: ['实际执行到终态并记录产物或错误'], extensions: {} }));
  const exportedRuns: any[] = [];
  for (const run of runs) {
    const evidence = { asset_id: `run-log-${run.id}`, version: '1' };
    assets.push({ ...evidence, asset_type: 'run_receipt', nature: 'run_log', source: '实际宿主运行状态、时间与事件记录', locator: `hyper-leader://runs/${run.id}`, sha256: null, subject_scope: `space:${spaceId}; case:${caseId}`, usage_scope: '本事项检查与恢复', availability: 'available', snapshot_at: new Date().toISOString(), derived_from: [], content: JSON.stringify({ ...run, events: leader.store.runEvents(run.id) }), extensions: {} });
    exportedRuns.push({ run_id: run.id, capability_ref: { id: `hyper-leader.run.${run.id}`, version: '0.1.0' }, policy_refs: [], execution_status: run.status, executor: 'Hyper Leader 本机宿主', implementation_version: '0.1.0', authorization_snapshot: capabilities.find(cap => cap.capability_id.endsWith(run.id))!.authorization, input_refs: validRefs(run.evidenceRefs), output_refs: artifacts.filter(artifact => artifact.runId === run.id).map(artifact => artifact.mdRef), runtime_evidence_refs: [evidence], started_at: run.startedAt ?? null, ended_at: run.finishedAt ?? null, failure: run.status === 'failed' ? (run.error ?? '实际运行未完成') : null, extensions: { hyper_leader: { stage: run.stage, delivery_status: run.limits.deliveryStatus ?? 'not_evaluated', limits: run.limits } } });
  }
  const decisions = artifacts.map(artifact => ({ decision_id: artifact.id, subject_refs: [artifact.mdRef], policy_refs: [], judgment_status: artifact.judgmentStatus, scope: '当前事项的待评议产物；本导出不声称领域符合性已审定。', rationale: artifact.summary || '详见当前实际产物及条件。', evidence_refs: validRefs(artifact.evidenceRefs), rule_checks: [], reviews: artifact.reviews, unknowns: ['如未取得相应专业、审美、人工或现实使用评议，继续保持未运行状态。'], next_actions: ['按本次需要的评议和条件继续核查。'], extensions: { hyper_leader: { domain: artifact.domain ?? null, artifact_record_version: artifact.version, domain_policy_version: artifact.domain ? leader.skills.catalogue().find(row => row.domain === artifact.domain)?.version : null, policy_formalization: 'source-method-version-bound; full policy-pack formalization not established by this export' } } }));
  return { protocol_version: PROTOCOL_VERSION, bundle_id: `hyper-leader.${caseId}.${Date.now()}`, nature: 'task_record', scenario: { scenario_id: caseId, subjects: [leader.space(spaceId).name], problem: matter.goal || matter.title, goal: matter.goal || matter.title, deliverables: ['实际分析与报告草稿'], constraints: ['主体／事项隔离', '只使用允许的来源版本', '不自动提交、交易或发布'], acceptance_level: 'draft_output', required_reviews: [], current_state: runs.some(run => run.status === 'running') ? 'execute' : 'deliver', extensions: { hyper_leader: { scope: 'case', space_id: spaceId } } }, policy_packs: [], capabilities, assets, decisions, runs: exportedRuns, delivery: { status: 'partial', scope: '导出当前实际记录，不自动认证业务目标已全部完成或各领域规则已形式化通过。', artifact_refs: artifacts.map(artifact => artifact.mdRef), decision_refs: artifacts.map(artifact => artifact.id), blocking_gaps: [], remaining_items: [{ code: 'HUMAN_REVIEW_PENDING', description: '产物和领域条件按实际需要继续评议；此导出不是自动完成认证。', affected_actions: ['正式采用相关业务结论'], next_action: '核对实际证据、规则版本与本次所需评议。' }], claims: [], next_actions: ['按当前事项要求继续核验和使用。'] }, extensions: { hyper_leader: { protocol_package: 'HP-0.2-AGENT-DRAFT-20261108', protocol_document_status: 'draft', protocol_adoption: 'selected_for_task', limitations: 'Source method versions are bound in assets/decision extensions. This runtime export does not invent formal policy rule checks or claim domain acceptance.' } } };
}
