import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Artifact, Asset, Run } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { completed, publicFixture, testHost } from './helpers.js';

describe('real local API and source lifecycle', () => {
  it('replays JSON writes with the same idempotency key and rejects a changed request body', async () => {
    const host = await testHost();
    try { const key = 'idempotency-fixture-0000000001'; const first = await host.request('POST', `${host.base}/cases`, { title: '幂等合成事项' }, { 'idempotency-key': key }); const second = await host.request('POST', `${host.base}/cases`, { title: '幂等合成事项' }, { 'idempotency-key': key }); expect(first.json().id).toBe(second.json().id); expect(second.headers['idempotent-replayed']).toBe('true'); expect((await host.request('POST', `${host.base}/cases`, { title: '不同请求' }, { 'idempotency-key': key })).statusCode).toBe(409); } finally { await host.close(); }
  });
  it('saves without reading, checks actual content, preserves snapshots and enforces scope', async () => {
    const calls: string[] = []; const host = await testHost({ reader: async (url, signal) => { calls.push(url); return publicFixture(url, signal); } });
    try {
      const added = await host.request('POST', `${host.base}/sources`, { name: '合成来源', kind: 'page', url: 'https://public.test/policy?batch=1', caseId: host.matter.id, scope: 'case', claimedKind: 'official' }); expect(added.statusCode).toBe(201); let source = added.json(); expect(source.accessStatus).toBe('not_checked'); expect(source.publisherStatus).toBe('user_declared'); expect(calls).toHaveLength(0);
      const duplicate = await host.request('POST', `${host.base}/sources`, { name: '不能重复', kind: 'page', url: source.url, caseId: host.matter.id }); expect(duplicate.statusCode).toBe(409);
      const check = await host.request('POST', `${host.base}/sources/${source.id}/check`, { descriptorVersion: 1 }); expect(check.statusCode).toBe(202); expect((await completed(host, check.json().id)).status).toBe('succeeded');
      const preview = (await host.request('GET', `${host.base}/sources/${source.id}/preview`)).json(); expect(preview.text).toContain('仅用于技术验收'); expect(preview.text).not.toContain('must not execute'); expect(preview.attachments).toHaveLength(1); expect(preview.evidenceStage).toBe('partial'); expect(preview.assetRef.asset_id).toBeTruthy();
      const other = (await host.request('POST', '/api/v1/spaces', { name: '另一主体', kind: 'company' })).json(); expect((await host.request('GET', `/api/v1/spaces/${other.id}/sources/${source.id}`)).statusCode).toBe(403);
      source = (await host.request('GET', `${host.base}/sources/${source.id}`)).json().source;
      const edited = await host.request('PATCH', `${host.base}/sources/${source.id}`, { version: source.version, name: '新版名称', url: 'https://public.test/policy?batch=2' }); expect(edited.statusCode).toBe(200); expect(edited.json().descriptorVersion).toBe(2); expect((await host.request('PATCH', `${host.base}/sources/${source.id}`, { version: source.version, name: '陈旧写入' })).statusCode).toBe(409);
      const oldSnapshot = host.store.get<any>('snapshot', preview.id); expect(oldSnapshot.url).toContain('batch=1'); expect(oldSnapshot.text).toContain('仅用于技术验收');
      const matter2 = (await host.request('POST', `${host.base}/cases`, { title: '另一事项' })).json(); expect((await host.request('PUT', `${host.base}/cases/${matter2.id}/sources`, { items: [{ sourceId: source.id, descriptorVersion: 2 }] })).statusCode).toBe(403);
    } finally { await host.close(); }
  });
  it('records failures without replacing prior readable content and stops use after removal', async () => {
    let fail = false; const host = await testHost({ reader: async (url, signal) => { if (fail) throw new Error('intentional source failure'); return publicFixture(url, signal); } });
    try { let source = (await host.request('POST', `${host.base}/sources`, { name: '来源', kind: 'page', url: 'https://public.test/a', caseId: host.matter.id })).json(); const first = (await host.request('POST', `${host.base}/sources/${source.id}/check`, { descriptorVersion: 1 })).json(); await completed(host, first.id); source = host.leader.sources.get(host.space.id, source.id); const snapshotId = source.latestSnapshotId; const snapshot = host.leader.sources.preview(host.space.id, source.id); const fence = host.leader.contextFence(host.matter);
      fail = true; const second = (await host.request('POST', `${host.base}/sources/${source.id}/refresh`, { descriptorVersion: 1 })).json(); expect((await completed(host, second.id)).status).toBe('failed'); source = host.leader.sources.get(host.space.id, source.id); expect(source.latestSnapshotId).toBe(snapshotId); expect(source.accessStatus).toBe('failed'); expect(source.lastError).toContain('intentional');
      expect((await host.request('DELETE', `${host.base}/sources/${source.id}`, { version: source.version })).statusCode).toBe(200); expect((await host.request('GET', `${host.base}/sources/${source.id}/preview`)).statusCode).toBe(410); expect(() => host.leader.assertEvidence(host.matter, snapshot.assetRef!)).toThrow(/暂停|移除/); expect(host.leader.contextFence(host.matter)).not.toBe(fence); expect((await host.leader.context(host.space.id, host.matter.id, true)).sources).toHaveLength(0);
    } finally { await host.close(); }
  });
  it('keeps RSS as discovery leads, not verified full opportunity text', async () => {
    const host = await testHost({ reader: async url => ({ url, status: 200, mime: 'application/rss+xml', headers: {}, data: Buffer.from('<rss><channel><title>合成Feed</title><item><title>合成项目</title><link>https://public.test/item</link><description>摘要不是全文</description></item></channel></rss>') }) });
    try { const source = host.leader.sources.create(host.space.id, { name: 'RSS', kind: 'rss', url: 'https://public.test/feed', caseId: host.matter.id }); const run = host.leader.checkSource(host.space.id, source.id, 1); await completed(host, run.id); const snapshot = host.leader.sources.preview(host.space.id, source.id); expect(snapshot.evidenceStage).toBe('partial'); expect(snapshot.links[0].url).toBe('https://public.test/item'); expect(snapshot.error).toContain('线索'); } finally { await host.close(); }
  });
  it('does not fake readable content for dynamic shells or login pages', async () => {
    const host = await testHost({ reader: async url => ({ url, status: 200, mime: 'text/html', headers: {}, data: Buffer.from(url.includes('login') ? '<html><body><form><input type="password"/></form>请登录</body></html>' : '<html><body><div id="app"></div><script src="/app.js"></script></body></html>') }) });
    try { for (const [part, expected] of [['shell', 'needs_browser'], ['login', 'needs_auth']]) { const source = host.leader.sources.create(host.space.id, { name: part, kind: 'page', url: `https://public.test/${part}`, caseId: host.matter.id }); const run = host.leader.checkSource(host.space.id, source.id, 1); await completed(host, run.id); expect(host.leader.sources.get(host.space.id, source.id).accessStatus).toBe(expected); } } finally { await host.close(); }
  });
  it('saves real escaped report files, keeps revision/acceptance separate and exports a valid bundle', async () => {
    const host = await testHost();
    try { const first = (await host.request('POST', `${host.caseBase}/artifacts`, { title: '技术报告', content: '# 合成稿\n<script>alert(1)</script>', evidence_refs: [] })).json() as Artifact;
      const html = await host.leader.assets.read(first.htmlRef, host.space.id, host.matter.id); expect(html.data.toString()).not.toContain('<script>'); expect(html.data.toString()).toContain('&lt;script&gt;'); expect(first.reviews.human_acceptance.status).toBe('not_run');
      const accepted = (await host.request('POST', `${host.caseBase}/artifacts/${first.id}/accept`, { version: first.version, confirm: true })).json(); expect(accepted.reviews.human_acceptance.reviewer_kind).toBe('human');
      const revision = (await host.request('POST', `${host.caseBase}/artifacts`, { title: '技术报告', content: '# 新合成稿', artifact_id: first.id, expected_version: accepted.version, evidence_refs: [] })).json(); expect(revision.reviews.human_acceptance.status).toBe('not_run'); expect((await host.leader.assets.read(first.mdRef, host.space.id)).data.toString()).toContain('合成稿'); expect(host.store.history('artifact', first.id)).toHaveLength(3);
      const forged = await host.request('POST', `${host.caseBase}/artifacts`, { title: '伪造认可', content: '不能接受', reviews: { human_acceptance: 'passed' } }); expect(forged.statusCode).toBe(400);
      const bundle = (await host.request('GET', `${host.caseBase}/bundle`)).json(); const file = path.join(host.home, 'bundle.json'); await writeFile(file, JSON.stringify(bundle)); const validate = path.join(host.leader.skills.protocolRoot, 'tools/validate_bundle.py'); const result = await promisify(execFile)(host.config.python(), ['-B', '-X', 'utf8', validate, file], { encoding: 'utf8' }); expect(JSON.parse(result.stdout).valid).toBe(true); expect(bundle.delivery.status).toBe('partial'); expect(bundle.decisions[0].judgment_status).toBe('needs_review');
    } finally { await host.close(); }
  });
  it('enforces browser session, origin, CSRF and internal runtime capability boundaries', async () => {
    const host = await testHost();
    try { expect((await host.app.inject({ method: 'GET', url: '/api/v1/spaces', headers: { host: '127.0.0.1:3228' } })).statusCode).toBe(401); expect((await host.request('POST', '/api/v1/spaces', { name: 'x' }, { 'x-csrf-token': 'wrong' })).statusCode).toBe(403); expect((await host.request('GET', '/api/v1/spaces', undefined, { host: 'evil.example:3228' })).statusCode).toBe(403); expect((await host.request('GET', '/api/v1/spaces', undefined, { origin: 'https://evil.example' })).statusCode).toBe(403); expect((await host.request('POST', '/internal/runtime/fake-id', { tool: 'leader_context', args: {} }, { 'x-runtime-token': 'forged' })).statusCode).toBe(403); expect((await host.request('POST', `${host.base}/sources`, { name: 'bad', kind: 'page', url: 'http://127.0.0.1:1234/private', caseId: host.matter.id })).statusCode).toBeGreaterThanOrEqual(400); } finally { await host.close(); }
  });
  it('stores only encrypted credentials and never imports ambient DeepSeek keys', async () => {
    const host = await testHost(); const key = 'sk-technical-fixture-key-not-real-123456789';
    try { const saved = await host.request('PATCH', '/api/v1/settings', { model: 'deepseek-flash', baseUrl: 'https://example.com/anthropic', maxTokens: 2048, maxSteps: 10, maxMinutes: 5, searchProvider: 'none', apiKey: key }); expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain(key); expect(host.config.key()).toBe(key); expect(await readFile(path.join(host.home, 'settings.json'), 'utf8')).not.toContain(key); expect((await host.request('GET', '/api/v1/settings')).body).not.toContain(key); expect((await host.request('POST', '/api/v1/settings/connections/model/check', { allowModelRequest: false })).statusCode).toBe(400); } finally { await host.close(); }
  });
  it('does not turn unbound declared enterprise facts into actionable eligibility', async () => {
    const host = await testHost();
    try { const artifact = await host.leader.evaluate(host.space.id, host.matter.id, 'enterprise', 'match', { profile: { company_name: '合成主体', facts: { eligible: { value: true, status: 'document_checked', source: 'invented-document', checked_at: '2026-11-10' } } }, policies: [{ id: 'P1', title: '合成政策', url: 'https://example.org/unread', review_state: 'reviewed', policy_validity: 'active', window: { status: 'open', end: '2099-01-01' }, eligibility: { field: 'eligible', op: 'eq', value: true } }] }, '未绑定证据的技术预筛', []); expect(artifact.content).toContain('VERIFY'); expect(artifact.content).toContain('unknown'); expect(artifact.judgmentStatus).toBe('needs_review'); expect(artifact.reviews.human_acceptance.status).toBe('not_run'); const bundle = (await host.request('GET', `${host.caseBase}/bundle`)).json(); expect(bundle.policy_packs.some((policy: any) => policy.policy_id === 'hyper-leader.enterprise.source-bound')).toBe(true); } finally { await host.close(); }
  });
  it('restores a removed source only through an explicit manual re-add and keeps SPA route locators', async () => {
    const host = await testHost();
    try { const input = { name: '页内路由样例', kind: 'page', url: 'https://public.test/?batch=2#/declare', caseId: host.matter.id }; const first = host.leader.sources.create(host.space.id, input); expect(first.url).toContain('#/declare'); host.leader.sourceLifecycle(host.space.id, first.id, 'removed', first.version); expect(() => host.leader.sources.create(host.space.id, { ...input, url: 'https://public.test/?batch=2&utm_source=variant#/declare' }, 'discovered')).toThrow(/登记|重复|已有/); const restored = host.leader.sources.create(host.space.id, input); expect(restored.id).toBe(first.id); expect(restored.descriptorVersion).toBe(2); expect(restored.accessStatus).toBe('not_checked'); expect(host.store.history('source', first.id).length).toBeGreaterThanOrEqual(3); } finally { await host.close(); }
  });
  it('tracks transitive report and action inputs without turning them into claimed evidence', async () => {
    const host = await testHost({ reader: publicFixture });
    try {
      const input = { name: '合成敏感来源', kind: 'page', url: 'https://public.test/transitive', caseId: host.matter.id };
      const source = host.leader.sources.create(host.space.id, input);
      await completed(host, host.leader.checkSource(host.space.id, source.id, 1).id);
      const snapshot = host.leader.sources.preview(host.space.id, source.id);
      const firstRun = host.leader.jobs.create(host.space.id, host.matter.id, 'analysis', '合成依赖关系单元检查，不代表真实模型运行', { status: 'running', evidenceRefs: [snapshot.assetRef!] });
      const first = await host.leader.saveArtifact(host.space.id, host.matter.id, { title: 'private-marker-report', content: 'private-marker-content', summary: 'private-marker-summary' }, firstRun.id);
      host.leader.createAction(host.space.id, host.matter.id, { title: 'private-marker-action', acceptance: 'private-marker-acceptance' }, firstRun.id);
      const current = await host.leader.context(host.space.id, host.matter.id, true);
      expect(current.inputRefs).toContainEqual(first.mdRef);
      const relayRun = host.leader.jobs.create(host.space.id, host.matter.id, 'analysis', '合成依赖传递检查', { status: 'running', evidenceRefs: current.inputRefs! });
      const relay = await host.leader.saveArtifact(host.space.id, host.matter.id, { title: 'private-marker-relay', content: 'private-marker-relayed-text' }, relayRun.id);
      expect(relay.evidenceRefs).toEqual([]);
      expect(host.leader.assets.get(relay.mdRef, host.space.id).derivedFrom).toContainEqual(first.mdRef);
      const version = host.leader.sources.get(host.space.id, source.id).version;
      host.leader.sourceLifecycle(host.space.id, source.id, 'removed', version);
      expect(JSON.stringify(await host.leader.context(host.space.id, host.matter.id, true))).not.toContain('private-marker');
      expect(JSON.stringify(await host.leader.context(host.space.id, host.matter.id))).toContain('private-marker');
      const restored = host.leader.sources.create(host.space.id, input);
      await completed(host, host.leader.checkSource(host.space.id, restored.id, restored.descriptorVersion).id);
      expect(() => host.leader.assertEvidence(host.matter, snapshot.assetRef!)).toThrow(/旧来源|版本/);
      expect(JSON.stringify(await host.leader.context(host.space.id, host.matter.id, true))).not.toContain('private-marker');
    } finally { await host.close(); }
  });
  it('reopens the actual SQLite data and preserves files while marking unfinished runs interrupted', async () => {
    const host = await testHost({ reader: publicFixture });
    let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const source = host.leader.sources.create(host.space.id, { name: '重启来源', kind: 'page', url: 'https://public.test/restart', caseId: host.matter.id });
      await completed(host, host.leader.checkSource(host.space.id, source.id, 1).id);
      const artifact = await host.leader.saveArtifact(host.space.id, host.matter.id, { title: '重启前草稿', content: '# 保留原版' });
      const pending = host.leader.jobs.create(host.space.id, host.matter.id, 'analysis', '模拟进程退出前尚未开始的记录');
      await host.app.close();
      restarted = await createApp({ root: process.cwd(), home: host.home, reader: publicFixture, tracking: false });
      expect(restarted.leader.matter(host.space.id, host.matter.id).title).toBe(host.matter.title);
      expect(restarted.leader.sources.preview(host.space.id, source.id).text).toContain('合成正文');
      expect((await restarted.leader.assets.read(artifact.mdRef, host.space.id)).data.toString()).toContain('保留原版');
      expect(restarted.store.get<Run>('run', pending.id).status).toBe('interrupted');
    } finally { await restarted?.app.close(); await host.close(); }
  });
});
