import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Artifact, Asset, Json, Run, Space, Tracking } from '../shared/types.js';
import { Store } from '../src/asset/store.js';
import { Leader } from '../src/function/service.js';
import { Runtime } from '../src/function/runtime.js';
import { Tracker } from '../src/function/tracking.js';
import { taskBundle } from '../src/function/protocol.js';
import type { PublicReader } from '../src/function/network.js';
import { AppError, errorText, invariant } from './errors.js';
import { Config } from './config.js';
import { browserRequest } from './security.js';
import { contained } from './files.js';

export async function createApp(options: { root: string; home?: string; reader?: PublicReader; origin?: string; tracking?: boolean; dev?: boolean }) {
  const config = new Config(options.root, options.home); await config.init(); const store = new Store(config.home); const leader = new Leader(config, store, options.reader); await leader.init(); const runtime = new Runtime(leader); const tracker = new Tracker(leader);
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024, requestTimeout: 120000 });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 12 } });
  let origin = options.origin ?? 'http://127.0.0.1:3220'; const csrf = randomBytes(32).toString('hex'), cookie = randomBytes(32).toString('hex'); runtime.setOrigin(origin);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    if (request.url.startsWith('/internal/runtime/')) return;
    if (request.url.startsWith('/api/')) browserRequest(request.headers, origin, !['GET', 'HEAD', 'OPTIONS'].includes(request.method), csrf, cookie, request.url.split('?')[0] === '/api/v1/bootstrap' || request.url.split('?')[0] === '/api/v1/health');
    else { browserRequest(request.headers, origin, false, csrf, cookie, true); reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"); }
  });
  app.setErrorHandler((error: any, _request, reply) => { let secret = ''; try { secret = config.key(); } catch { /* Never expose corrupt ciphertext. */ } const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : error.statusCode && error.statusCode < 500 ? error.statusCode : 500; const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.') || '输入'}：${issue.message}`).join('；').slice(0, 2000) : errorText(error, secret); reply.code(status).send({ error: { code: error.code ?? 'REQUEST_FAILED', message } }); });
  app.addHook('preHandler', async (request, reply) => {
    const key = request.headers['idempotency-key']; if (!key || !request.url.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method) || request.isMultipart()) return;
    invariant(typeof key === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(key), 400, '幂等键格式无效。');
    const signature = createHash('sha256').update(`${request.method}\n${request.url}\n${JSON.stringify(request.body)}`).digest('hex');
    const existing = store.db.prepare('SELECT * FROM idempotency WHERE key=?').get(key) as any;
    if (existing) { invariant(existing.signature === signature, 409, '此幂等键已用于不同请求，请核对实际操作。', 'IDEMPOTENCY_CONFLICT'); invariant(existing.state === 'completed', 409, '相同操作仍在执行或上次状态未确认，请先检查实际记录，不自动重发。', 'IDEMPOTENCY_PENDING'); reply.header('Idempotent-Replayed', 'true').code(existing.status).type('application/json').send(JSON.parse(existing.body)); return; }
    store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?)').run(key, signature, 'pending', null, null, new Date().toISOString());
    (request as any).leaderIdempotency = key;
  });
  app.addHook('onSend', async (request, reply, payload) => { const key = (request as any).leaderIdempotency; if (key && typeof payload === 'string') store.db.prepare('UPDATE idempotency SET state=?,status=?,body=? WHERE key=?').run('completed', reply.statusCode, payload, key); return payload; });
  const params = (request: any) => request.params as Record<string, string>;
  const query = (request: any) => request.query as Record<string, string>;
  const scope = (request: any) => { const p = params(request); leader.space(p.spaceId); if (p.caseId) leader.matter(p.spaceId, p.caseId); return p; };
  app.get('/api/v1/health', async () => ({ ok: true, application: 'hyper-leader', version: '0.1.0' }));
  app.get('/api/v1/bootstrap', async (_request, reply) => { reply.header('Set-Cookie', `leader_session=${cookie}; HttpOnly; SameSite=Strict; Path=/`); return { csrf, settings: await config.public(), spaces: store.list<Space>('space'), version: '0.1.0', deployment: 'local-single-user', noPrivateProjectImport: true }; });
  app.get('/api/v1/capabilities', async () => ({ methods: leader.skills.catalogue(), settings: await config.public(), supportedFiles: ['PDF', 'DOCX', 'XLSX', 'CSV', 'TXT', 'MD'], sourceTypes: ['page', 'website', 'rss', 'file'], browserReading: { available: false, reason: '本版动态页面明确标需浏览器补读，可上传获准正文。' }, tracking: { available: true, scope: '仅应用运行期间按明确授权刷新来源，不自动调用模型。' }, runtime: { officialDSH: true, arbitraryTerminal: false, arbitraryFilesystem: false, privateKnowledgeBase: false }, limitations: ['来源目录不是全球完整覆盖', '脚本通过不是专业或人工认可', '本机加密不防同一系统账户的完全控制'] }));
  app.get('/api/v1/settings', async () => config.public());
  app.patch('/api/v1/settings', async request => config.save(request.body));
  app.post('/api/v1/settings/connections/:connectorId/check', async request => { const id = params(request).connectorId; if (id === 'model') return runtime.testConnection(z.object({ allowModelRequest: z.literal(true) }).strict().parse(request.body).allowModelRequest); if (id === 'environment') return { settings: await config.public(), methods: leader.skills.catalogue(), noModelRequest: true }; throw new AppError(400, '未配置此连接器。'); });
  app.get('/api/v1/spaces', async () => store.list<Space>('space'));
  app.post('/api/v1/spaces', async (request, reply) => { reply.code(201); return leader.createSpace(request.body); });
  app.patch('/api/v1/spaces/:spaceId', async request => { const p = scope(request); return leader.updateSpace(p.spaceId, request.body as Json); });
  app.get('/api/v1/spaces/:spaceId/cases', async request => { const p = scope(request); return store.list('case', { spaceId: p.spaceId }); });
  app.post('/api/v1/spaces/:spaceId/cases', async (request, reply) => { const p = scope(request); reply.code(201); return leader.createCase(p.spaceId, request.body); });
  app.get('/api/v1/spaces/:spaceId/cases/:caseId', async request => { const p = scope(request); return leader.context(p.spaceId, p.caseId); });
  app.post('/api/v1/spaces/:spaceId/cases/:caseId/messages', async (request, reply) => { const p = scope(request); const run = runtime.start(p.spaceId, p.caseId, request.body); reply.code(202); return run; });
  app.get('/api/v1/runs/:runId', async request => store.get<Run>('run', params(request).runId));
  app.post('/api/v1/runs/:runId/cancel', async request => leader.jobs.cancel(params(request).runId));
  app.post('/api/v1/runs/:runId/answers', async request => { const body = z.object({ questionId: z.string().uuid(), answer: z.string().trim().min(1).max(10000) }).strict().parse(request.body); await runtime.answer(params(request).runId, body.questionId, body.answer); return { accepted: true }; });
  const streams = new Set<import('node:http').ServerResponse>();
  app.get('/api/v1/runs/:runId/events', async (request, reply) => {
    const id = params(request).runId; store.get('run', id); const after = Number(query(request).after ?? request.headers['last-event-id'] ?? 0); invariant(Number.isSafeInteger(after) && after >= 0, 400, '事件游标无效。');
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    streams.add(reply.raw);
    const send = (event: Json) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); }; for (const event of store.runEvents(id, after)) send(event);
    if (!['running', 'not_started'].includes(store.get<Run>('run', id).status)) { streams.delete(reply.raw); reply.raw.end(); return; }
    const listener = (event: Json) => { send(event); if (!['running', 'not_started'].includes(store.get<Run>('run', id).status)) reply.raw.end(); }; store.events.on(id, listener); const heartbeat = setInterval(() => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': keepalive\n\n'); }, 15000); heartbeat.unref(); reply.raw.on('close', () => { streams.delete(reply.raw); clearInterval(heartbeat); store.events.off(id, listener); });
  });
  app.post('/api/v1/spaces/:spaceId/materials', async (request, reply) => {
    const p = scope(request); const fields: Json = {}; let upload: { filename: string; buffer: Buffer } | undefined;
    for await (const part of request.parts()) { if (part.type === 'file') { upload = { filename: part.filename, buffer: await part.toBuffer() }; if (part.file.truncated) throw new AppError(413, '资料超过20 MiB。'); } else fields[part.fieldname] = part.value; }
    invariant(upload, 400, '请选择文件。'); if (fields.caseId) leader.matter(p.spaceId, z.string().uuid().parse(fields.caseId));
    const result = await leader.upload(p.spaceId, fields.caseId || undefined, upload.filename, upload.buffer, fields); reply.code(201); return result;
  });
  app.get('/api/v1/spaces/:spaceId/sources', async request => { const p = scope(request); const caseId = query(request).caseId; if (caseId) leader.matter(p.spaceId, caseId); return leader.sources.list(p.spaceId, caseId); });
  app.post('/api/v1/spaces/:spaceId/sources', async (request, reply) => { const p = scope(request); reply.code(201); return leader.sources.create(p.spaceId, request.body); });
  app.get('/api/v1/spaces/:spaceId/sources/:sourceId', async request => { const p = scope(request); return { source: leader.sources.get(p.spaceId, p.sourceId), versions: store.history('source', p.sourceId).map((row: any) => ({ version: row.version, descriptorVersion: row.descriptorVersion, name: row.name, url: row.url, lifecycle: row.lifecycle, updatedAt: row.updatedAt })), snapshots: store.list<any>('snapshot', { spaceId: p.spaceId }).filter(row => row.sourceId === p.sourceId).map(({ text: _text, ...row }) => row) }; });
  app.patch('/api/v1/spaces/:spaceId/sources/:sourceId', async request => { const p = scope(request); const result = leader.sources.edit(p.spaceId, p.sourceId, request.body as Json); leader.cancelSourceRuns(p.spaceId, p.sourceId); return result; });
  for (const operation of ['check', 'refresh']) app.post(`/api/v1/spaces/:spaceId/sources/:sourceId/${operation}`, async (request, reply) => { const p = scope(request); const body = z.object({ descriptorVersion: z.number().int().positive() }).strict().parse(request.body); const run = leader.checkSource(p.spaceId, p.sourceId, body.descriptorVersion); reply.code(202); return run; });
  app.get('/api/v1/spaces/:spaceId/sources/:sourceId/preview', async request => { const p = scope(request); return leader.sources.preview(p.spaceId, p.sourceId, query(request).snapshotId); });
  app.post('/api/v1/spaces/:spaceId/sources/:sourceId/pause', async request => { const p = scope(request); const body = z.object({ version: z.number().int().positive(), paused: z.boolean().default(true) }).strict().parse(request.body); return leader.sourceLifecycle(p.spaceId, p.sourceId, body.paused ? 'paused' : 'active', body.version); });
  app.delete('/api/v1/spaces/:spaceId/sources/:sourceId', async request => { const p = scope(request); const body = z.object({ version: z.number().int().positive() }).strict().parse(request.body); return leader.sourceLifecycle(p.spaceId, p.sourceId, 'removed', body.version); });
  app.put('/api/v1/spaces/:spaceId/cases/:caseId/sources', async request => { const p = scope(request); invariant(!store.list<Run>('run', { caseId: p.caseId }).some(row => row.kind === 'analysis' && row.status === 'running'), 409, '请先停止分析，再变更本轮资料采用范围。'); const body = z.object({ items: z.array(z.object({ sourceId: z.string().uuid(), descriptorVersion: z.number().int().positive() }).strict()).max(200) }).strict().parse(request.body); return leader.sources.bind(p.spaceId, p.caseId, body.items); });
  app.get('/api/v1/spaces/:spaceId/cases/:caseId/artifacts', async request => { const p = scope(request); return store.list<Artifact>('artifact', { caseId: p.caseId }); });
  app.get('/api/v1/spaces/:spaceId/cases/:caseId/artifacts/:artifactId/versions', async request => { const p = scope(request); const artifact = store.get<Artifact>('artifact', p.artifactId); invariant(artifact.spaceId === p.spaceId && artifact.caseId === p.caseId, 403, '成果不属于当前事项。'); return store.history<Artifact>('artifact', p.artifactId); });
  app.post('/api/v1/spaces/:spaceId/cases/:caseId/artifacts/:artifactId/accept', async request => { const p = scope(request); const body = z.object({ version: z.number().int().positive(), confirm: z.literal(true) }).strict().parse(request.body); return leader.acceptArtifact(p.spaceId, p.caseId, p.artifactId, body.version); });
  app.post('/api/v1/spaces/:spaceId/cases/:caseId/artifacts', async request => { const p = scope(request); return leader.saveArtifact(p.spaceId, p.caseId, request.body); });
  app.get('/api/v1/spaces/:spaceId/cases/:caseId/bundle', async (request, reply) => { const p = scope(request); reply.header('Content-Disposition', 'attachment; filename="hyper-leader-task-bundle.json"'); return taskBundle(leader, p.spaceId, p.caseId); });
  app.get('/api/v1/assets/:assetId/versions/:version/download', async (request, reply) => { const p = params(request); const asset = store.get<Asset>('asset', p.assetId); const read = await leader.assets.read({ asset_id: asset.id, version: p.version }, asset.spaceId); if (asset.meta.sourceId) invariant(leader.sources.get(asset.spaceId, asset.meta.sourceId).lifecycle === 'active', 410, '来源已暂停或移除。'); reply.header('Content-Disposition', `attachment; filename="download${path.extname(asset.name).replace(/[^a-zA-Z0-9.]/g, '')}"; filename*=UTF-8''${encodeURIComponent(asset.name)}`).type(asset.mime); if (asset.mime === 'text/html') reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"); return read.data; });
  app.get('/api/v1/spaces/:spaceId/cases/:caseId/actions', async request => { const p = scope(request); return store.list('action', { caseId: p.caseId }); });
  app.post('/api/v1/spaces/:spaceId/cases/:caseId/actions', async request => { const p = scope(request); return leader.createAction(p.spaceId, p.caseId, request.body); });
  app.patch('/api/v1/spaces/:spaceId/cases/:caseId/actions/:actionId', async request => { const p = scope(request); return leader.updateAction(p.spaceId, p.caseId, p.actionId, request.body as Json); });
  app.get('/api/v1/spaces/:spaceId/tracking', async request => { const p = scope(request); return store.list<Tracking>('tracking', { spaceId: p.spaceId }); });
  app.post('/api/v1/spaces/:spaceId/tracking', async request => { const p = scope(request); return tracker.create(p.spaceId, request.body); });
  app.patch('/api/v1/spaces/:spaceId/tracking/:trackingId', async request => { const p = scope(request); return tracker.update(p.spaceId, p.trackingId, request.body); });
  app.delete('/api/v1/spaces/:spaceId/tracking/:trackingId', async request => { const p = scope(request); const row = store.get<Tracking>('tracking', p.trackingId); invariant(row.spaceId === p.spaceId, 403, '订阅不属于此主体。'); return tracker.update(p.spaceId, p.trackingId, { version: row.version, enabled: false }); });
  app.post('/internal/runtime/:runId', async request => { browserRequest(request.headers, origin, false, csrf, cookie, true); const body = z.object({ tool: z.string().max(100), args: z.record(z.string(), z.unknown()) }).strict().parse(request.body); return runtime.modelView(await runtime.tool(params(request).runId, request.headers['x-runtime-token'], body.tool, body.args)); });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/internal/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
    if (!['GET', 'HEAD'].includes(request.method)) return reply.code(404).send();
    const webRoot = path.join(options.root, 'dist/web'); const requested = request.url.split('?')[0];
    if (requested.startsWith('/assets/')) { invariant(/^\/assets\/[a-zA-Z0-9_.-]+$/.test(requested), 403, '静态路径无效。'); const file = path.resolve(webRoot, `.${requested}`); invariant(contained(webRoot, file), 403, '静态路径越界。'); const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }; const data = await readFile(file); return reply.type(mime[path.extname(file)] ?? 'application/octet-stream').send(data); }
    const index = await readFile(path.join(webRoot, 'index.html'), 'utf8').catch(() => null); if (!index) return reply.code(503).type('text/plain').send('前端尚未构建，请运行 npm run build。'); return reply.type('text/html').send(index);
  });
  if (options.tracking !== false) tracker.start();
  app.addHook('preClose', async () => { tracker.close(); for (const stream of streams) stream.end(); streams.clear(); await leader.jobs.close(); await runtime.close(); });
  app.addHook('onClose', async () => { store.close(); });
  return { app, leader, runtime, tracker, config, store, setOrigin(value: string) { origin = value; runtime.setOrigin(value); } };
}
