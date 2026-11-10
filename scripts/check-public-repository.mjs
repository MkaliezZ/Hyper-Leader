// Checks the staged Git tree, not private working-directory contents. Never prints secrets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const rootFiles = new Set(['.gitignore', '.env.example', 'package.json', 'package-lock.json', 'requirements.txt', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'start.cmd', 'start.sh']);
const codeDirectories = /^(src|server|shared|web|runtime|workers|scripts|tests|licenses)\//;
const denied = /^(?:AGENTS\.md$|(?:00-|10-|20-|30-|90-)|\.local(?:\/|$)|\.venv(?:\/|$)|node_modules\/|dist\/|test-results\/|playwright-report\/|scripts\/create-implementation-handoff\.mjs$)|(?:^|\/)(?:__pycache__|\.git)(?:\/|$)|\.(?:sqlite(?:-shm|-wal)?|log|key|zip|pyc)$/i;
const files = git(['ls-files', '--cached', '-z']).toString('utf8').split('\0').filter(Boolean);
if (!files.length) throw new Error('No staged source files. Stage only the intended public code first.');
const findings = [];
const entries = [];
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/g],
  ['api-key-like', /sk-[A-Za-z0-9_-]{16,}/g],
  ['private-workstation-path', /(?:F:[\\/]+Opencode Workspace|C:[\\/]+Users[\\/]+Administrator|file:\/\/\/F:\/)/gi],
];
for (const filename of files) {
  if (denied.test(filename) || (!rootFiles.has(filename) && !codeDirectories.test(filename))) { findings.push({ file: filename, kind: 'not_in_public_source_allowlist' }); continue; }
  const bytes = git(['show', `:${filename}`]);
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) { findings.push({ file: filename, kind: 'unexpected_large_or_binary_input' }); continue; }
  const text = bytes.toString('utf8');
  for (const [kind, expression] of patterns) for (const match of text.matchAll(expression)) {
    const fixture = kind === 'api-key-like' && /^(?:tests\/|scripts\/runtime-smoke\.ts$)/.test(filename) && /fixture|not-real/i.test(match[0]);
    if (!fixture) findings.push({ file: filename, line: text.slice(0, match.index).split('\n').length, kind });
  }
  entries.push({ path: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const name of ['README.md', 'README.zh-CN.md', 'package-lock.json', 'server/index.ts', 'web/App.tsx', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) if (!files.includes(name)) findings.push({ file: name, kind: 'required_public_file_missing' });
if (!findings.length) try { git(['diff', '--cached', '--check']); } catch { findings.push({ kind: 'staged_whitespace_check_failed' }); }
const report = { checked_at: new Date().toISOString(), scope: 'Explicit staged public-source allowlist, private-path exclusions, size/binary checks and heuristic secret scan. Not a guarantee of detecting every sensitive datum or a license certification.', passed: !findings.length, staged_files: entries.length, findings, files: entries };
await mkdir(path.join(root, '.local/verification'), { recursive: true });
await writeFile(path.join(root, '.local/verification/public-repository-check.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: report.passed, stagedFiles: entries.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
