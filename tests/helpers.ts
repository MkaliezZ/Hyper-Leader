import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import type { PublicReader } from '../src/function/network.js';
import type { Run } from '../shared/types.js';
export async function testHost(options: { reader?: PublicReader; listen?: boolean } = {}) {
  const parent = path.join(os.tmpdir(), 'opencode'); await mkdir(parent, { recursive: true }); const home = await mkdtemp(path.join(parent, 'hyper-leader-test-'));
  const host = await createApp({ root: process.cwd(), home, origin: 'http://127.0.0.1:3228', reader: options.reader, tracking: false });
  let origin = 'http://127.0.0.1:3228'; if (options.listen) { origin = await host.app.listen({ port: 0, host: '127.0.0.1' }); host.setOrigin(origin); }
  const bootstrap = await host.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { host: new URL(origin).host } }); const csrf = bootstrap.json().csrf; const cookie = String(bootstrap.headers['set-cookie']).split(';')[0];
  const request = (method: string, url: string, payload?: unknown, more: Record<string, string> = {}) => host.app.inject({ method: method as any, url, headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': csrf, ...more }, payload: payload as any });
  const space = (await request('POST', '/api/v1/spaces', { name: '技术验收主体（合成）', kind: 'company', profile: '' })).json();
  const matter = (await request('POST', `/api/v1/spaces/${space.id}/cases`, { title: '技术验收事项（合成）', intent: 'general' })).json();
  return { ...host, home, origin, csrf, cookie, request, space, matter, base: `/api/v1/spaces/${space.id}`, caseBase: `/api/v1/spaces/${space.id}/cases/${matter.id}`, async close() { await host.app.close(); if (path.dirname(home) === parent && path.basename(home).startsWith('hyper-leader-test-')) await rm(home, { recursive: true, force: true }); } };
}
export function completed(host: Awaited<ReturnType<typeof testHost>>, runId: string, timeout = 80000): Promise<Run> {
  return new Promise((resolve, reject) => { const check = () => { const row = host.store.get<Run>('run', runId); if (!['running', 'not_started'].includes(row.status)) { clearTimeout(timer); host.store.events.off(runId, check); resolve(row); } }; const timer = setTimeout(() => { host.store.events.off(runId, check); reject(new Error(`Run did not terminate: ${runId}`)); }, timeout); host.store.events.on(runId, check); check(); });
}
export const publicFixture: PublicReader = async url => ({ url, status: 200, mime: 'text/html', headers: { 'content-type': 'text/html; charset=utf-8' }, data: Buffer.from('<html><head><title>合成官方页面测试</title></head><body><article><h1>合成正文</h1><p>仅用于技术验收，不代表现实政策或企业资质。此处记录当前文件的实际段落和内容。</p><p>条件需要逐项核查，公开页面不能直接推定用户已经符合申请资格。</p><a href="/attachment.pdf">申报附件（合成）</a></article><script>throw new Error("must not execute")</script></body></html>') });
