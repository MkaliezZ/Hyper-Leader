import { testHost, completed } from '../tests/helpers.js';
import { modelServer } from '../tests/fixtures/model-server.js';
const fixture = await modelServer((_body, index) => index === 0 ? { tool: { name: 'leader_context', input: {} } } : index === 1 ? { tool: { name: 'leader_save_artifact', input: { title: '运行时技术验收（合成）', content: '# 本机协议夹具\n仅用于技术检查，不是实际业务结论。', evidence_json: '[]' } } } : { text: '已实际保存合成稿；没有调用真实付费模型。' });
const host = await testHost({ listen: true });
try {
  await host.config.save({ apiKey: 'sk-local-fixture-not-real-000000000000', model: 'deepseek-flash', baseUrl: fixture.url, maxTokens: 2048, maxSteps: 8, maxMinutes: 3, searchProvider: 'none' });
  const response = await host.request('POST', `${host.caseBase}/messages`, { content: '执行本机技术验收并保存合成报告。', requireArtifact: true });
  if (response.statusCode !== 202) throw new Error(response.body);
  const run = await completed(host, response.json().id);
  if (run.status !== 'succeeded' || run.limits.deliveryStatus !== 'completed' || !run.artifactIds.length) throw new Error(run.error ?? JSON.stringify(run));
  console.log(JSON.stringify({ ok: true, scope: 'Actual official DSH process, scoped tool execution and saved files, with a local model protocol fixture only.', requests: fixture.requests.length, artifacts: run.artifactIds.length, advertisedTools: fixture.requests[0]?.tools?.map((tool: any) => tool.name), externalModelCalls: 0, humanOrDomainAcceptance: false }, null, 2));
} finally { await host.close(); await fixture.close(); }
