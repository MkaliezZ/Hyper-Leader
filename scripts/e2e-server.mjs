import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/server.ts'], { stdio: 'inherit', cwd: process.cwd(), shell: false });
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
