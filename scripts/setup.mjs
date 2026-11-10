import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }); if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status ?? 1); }
if (!existsSync(python)) run(process.env.HYPER_LEADER_BOOTSTRAP_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', path.join(root, '.venv')]);
run(python, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '-r', path.join(root, 'requirements.txt')]);
run(python, ['-c', 'import bs4,requests,pypdf,jsonschema,docx,openpyxl; print("Hyper Leader 独立 Python 环境就绪；未配置模型、未下载任何模型权重。")']);
