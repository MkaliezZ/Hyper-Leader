import { expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { testHost, completed, publicFixture } from './helpers.js';
import { modelServer } from './fixtures/model-server.js';
import type { Artifact, Binding, Message, Run } from '../shared/types.js';

it('runs the official DSH process and actual scoped tools against a local protocol fixture', async () => {
  const fixture = await modelServer((body, index) => {
    if (index === 0) return { tool: { name: 'leader_context', input: {} } };
    if (index === 1) return { tool: { name: 'leader_reference', input: { domain: 'market', name: 'SKILL.md' } } };
    if (index === 2) return { tool: { name: 'leader_save_artifact', input: { title: 'DSH 技术验收合成稿', content: '# 协议夹具产物\n\n这不是实际商业判断，仅验证官方SDK、工具桥与文件保存。', summary: '本机协议往返，不调用外部付费模型。', evidence_json: '[]' } } };
    if (index >= 4 && !body.messages?.at(-1)?.content?.some?.((block: any) => block.type === 'tool_result')) return { tool: { name: 'leader_context', input: {} } };
    return { text: '已实际保存技术验收合成稿。本结果由本机协议夹具产生，不代表真实模型业务质量。' };
  });
  const host = await testHost({ listen: true });
  try {
    await host.config.save({ apiKey: 'sk-local-test-key-not-real-000000000000', baseUrl: fixture.url, model: 'deepseek-flash', maxTokens: 2048, maxSteps: 10, maxMinutes: 3, searchProvider: 'none' });
    expect(fixture.requests).toHaveLength(0);
    const submitted = await host.request('POST', `${host.caseBase}/messages`, { content: '执行合成技术检查并保存草稿，不作商业判断。', intent: 'market', requireArtifact: true }); expect(submitted.statusCode).toBe(202);
    const run = await completed(host, submitted.json().id); expect(run.status, run.error).toBe('succeeded'); expect(run.limits.deliveryStatus, JSON.stringify({ events: host.store.runEvents(run.id), messages: fixture.requests.map(request => request.messages?.at(-1)) }, null, 2)).toBe('completed');
    const artifacts = host.store.list<Artifact>('artifact', { caseId: host.matter.id }); expect(artifacts).toHaveLength(1); expect((await host.leader.assets.read(artifacts[0].mdRef, host.space.id)).data.toString()).toContain('协议夹具产物'); expect(artifacts[0].reviews.human_acceptance.status).toBe('not_run');
    expect(fixture.requests.length).toBeGreaterThanOrEqual(4); const names = fixture.requests[0].tools.map((tool: any) => tool.name); expect(names).toContain('leader_save_artifact'); expect(names.every((name: string) => name.startsWith('leader_'))).toBe(true);
    const matter = host.leader.matter(host.space.id, host.matter.id); expect(matter.runtimeStarted).toBe(true); expect((await stat(path.join(host.home, 'dsh', host.matter.id, 'sessions'))).isDirectory()).toBe(true);
    const oldSession = matter.sessionId; const second = await host.request('POST', `${host.caseBase}/messages`, { content: '继续本轮技术对话。', intent: 'general' }); expect((await completed(host, second.json().id)).status).toBe('succeeded'); expect(host.leader.matter(host.space.id, host.matter.id).sessionId).toBe(oldSession);
    const source = host.leader.sources.create(host.space.id, { name: '新资料范围', kind: 'page', url: 'https://public.test/new', caseId: host.matter.id }); const changed = await host.request('POST', `${host.caseBase}/messages`, { content: '资料范围改变后继续。', intent: 'general' }); expect((await completed(host, changed.json().id)).status).toBe('succeeded'); expect(host.leader.matter(host.space.id, host.matter.id).sessionId).not.toBe(oldSession);
  } finally { await host.close(); await fixture.close(); }
});

it('does not invent a report when a successful model turn saves no artifact', async () => {
  const fixture = await modelServer((_body, index) => index === 0 ? { tool: { name: 'leader_context', input: {} } } : { text: '仅为合成文字回复，没有保存文件。' }); const host = await testHost({ listen: true });
  try { await host.config.save({ apiKey: 'sk-fixture-only-not-real-000000000000', baseUrl: fixture.url, model: 'deepseek-flash', maxTokens: 2048, maxSteps: 5, maxMinutes: 3, searchProvider: 'none' }); const response = await host.request('POST', `${host.caseBase}/messages`, { content: '生成合成报告', requireArtifact: true }); const run = await completed(host, response.json().id); expect(run.status).toBe('succeeded'); expect(run.limits.deliveryStatus).toBe('partial'); expect(host.store.list('artifact', { caseId: host.matter.id })).toHaveLength(0); expect(host.store.list<Message>('message', { caseId: host.matter.id }).at(-1)?.content).toContain('尚未保存'); } finally { await host.close(); await fixture.close(); }
});

it('binds a shared source to the reading case and cancels its live DSH task when paused', async () => {
  const host = await testHost({ listen: true, reader: publicFixture });
  const source = host.leader.sources.create(host.space.id, { name: '共享来源', kind: 'page', url: 'https://public.test/shared', scope: 'space' });
  const fixture = await modelServer((_body, index) => index === 0 ? { tool: { name: 'leader_context', input: {} } } : index === 1 ? { tool: { name: 'leader_read_source', input: { source_id: source.id } } } : { tool: { name: 'leader_ask_user', input: { question: '合成暂停检查：等待实际回答', options: [] } } });
  try {
    await host.config.save({ apiKey: 'sk-shared-fixture-not-real-000000000000', baseUrl: fixture.url, model: 'deepseek-flash', maxTokens: 2048, maxSteps: 8, maxMinutes: 3, searchProvider: 'none' });
    const response = await host.request('POST', `${host.caseBase}/messages`, { content: '只检查共享来源读取和停止，不作业务判断。' });
    expect(response.statusCode).toBe(202);
    const runId = response.json().id;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { host.store.events.off(runId, check); reject(new Error('DSH did not reach the question checkpoint')); }, 60000);
      const check = () => { const run = host.store.get<Run>('run', runId); if (run.question) { clearTimeout(timer); host.store.events.off(runId, check); resolve(); } else if (!['running', 'not_started'].includes(run.status)) { clearTimeout(timer); host.store.events.off(runId, check); reject(new Error(run.error ?? 'Task stopped before the checkpoint')); } };
      host.store.events.on(runId, check); check();
    });
    expect(host.store.list<Binding>('binding', { caseId: host.matter.id }).some(binding => binding.sourceId === source.id && binding.enabled)).toBe(true);
    const current = host.leader.sources.get(host.space.id, source.id);
    host.leader.sourceLifecycle(host.space.id, source.id, 'paused', current.version);
    expect((await completed(host, runId)).status).toBe('cancelled');
    expect(host.store.get<Run>('run', runId).question).toBeUndefined();
    expect((await host.leader.context(host.space.id, host.matter.id, true)).sources).toHaveLength(0);
  } finally { await host.close(); await fixture.close(); }
});
