import { createApp } from './app.js';
import { acquireLock } from './security.js';
import path from 'node:path';
const root = process.cwd();
const home = path.resolve(process.env.HYPER_LEADER_HOME ?? path.join(root, '.local'));
const port = Number(process.env.HYPER_LEADER_PORT ?? 3220);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HYPER_LEADER_PORT 必须为1024–65535的本机端口。');
const release = await acquireLock(home);
let host: Awaited<ReturnType<typeof createApp>> | undefined;
try { host = await createApp({ root, home, origin: `http://127.0.0.1:${port}` }); await host.app.listen({ host: '127.0.0.1', port }); console.log(`Hyper Leader 已启动：http://127.0.0.1:${port}\n只监听本机；模型配置和私有资料保存在独立数据目录，不导入其他项目。`); }
catch (error) { await host?.app.close().catch(() => undefined); await release(); throw error; }
let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await host?.app.close(); await release(); process.exit(0); };
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
