import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { testHost, completed } from '../tests/helpers.js';
const host = await testHost();
try {
  const source = host.leader.sources.create(host.space.id, { name: '中国政府网政策（公开读取技术检查）', kind: 'website', url: 'https://www.gov.cn/zhengce/', scope: 'case', caseId: host.matter.id });
  const run = host.leader.checkSource(host.space.id, source.id, source.descriptorVersion); const terminal = await completed(host, run.id, 60000); const current = host.leader.sources.get(host.space.id, source.id);
  const snapshot = current.latestSnapshotId ? host.leader.sources.preview(host.space.id, source.id) : undefined;
  const record = { at: new Date().toISOString(), scope: 'One actual public read through the production DNS/redirect/content pipeline; no model request, no private query, no comprehensive or eligibility claim.', url: source.url, executionStatus: terminal.status, accessStatus: current.accessStatus, title: snapshot?.title ?? null, charactersRead: snapshot?.text.length ?? 0, evidenceStage: snapshot?.evidenceStage ?? null, discoveredLinks: snapshot?.links.length ?? 0, attachments: snapshot?.attachments.length ?? 0, error: current.lastError ?? terminal.error ?? null };
  const output = path.join(process.cwd(), '.local', 'verification'); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'actual-public-source.json'), JSON.stringify(record, null, 2)); console.log(JSON.stringify(record, null, 2));
} finally { await host.close(); }
