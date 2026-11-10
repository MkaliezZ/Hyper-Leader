import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { taskBundle } from '../src/function/protocol.js';

it('runs the public application without copying private inputs and reports missing methods honestly', async () => {
  const parent = path.join(os.tmpdir(), 'opencode'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'hyper-leader-public-'));
  const host = await createApp({ root, home: path.join(root, '.local'), origin: 'http://127.0.0.1:3228', tracking: false });
  try {
    expect(host.leader.skills.catalogue()).toHaveLength(4);
    expect(host.leader.skills.catalogue().every(method => !method.available && method.files.length === 0)).toBe(true);
    await expect(host.leader.skills.reference('market', 'SKILL.md')).rejects.toMatchObject({ status: 503, code: 'METHOD_UNAVAILABLE' });
    const space = host.leader.createSpace({ name: 'Public-code synthetic workspace', kind: 'company' });
    const matter = host.leader.createCase(space.id, { title: 'Private-input-free engineering check' });
    const report = await host.leader.saveArtifact(space.id, matter.id, { title: 'Synthetic local write', content: '# Public code check\nNo external model was called.' });
    expect((await host.leader.assets.read(report.mdRef, space.id)).data.toString()).toContain('No external model');
    await expect(taskBundle(host.leader, space.id, matter.id)).rejects.toMatchObject({ status: 503, code: 'PROTOCOL_UNAVAILABLE' });
    const health = await host.app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: '127.0.0.1:3228' } });
    expect(health.statusCode).toBe(200);
    expect(health.json().application).toBe('hyper-leader');
  } finally { await host.app.close(); if (path.dirname(root) === parent && path.basename(root).startsWith('hyper-leader-public-')) await rm(root, { recursive: true, force: true }); }
});

it('ships separate linked English and Chinese READMEs without private-only document links', async () => {
  const english = await readFile('README.md', 'utf8');
  const chinese = await readFile('README.zh-CN.md', 'utf8');
  expect(english).toContain('[简体中文](README.zh-CN.md)');
  expect(chinese).toContain('[English](README.md)');
  expect(english).toContain('public repository');
  expect(chinese).toContain('公开仓库');
  for (const text of [english, chinese]) {
    expect(text).toContain('npm run test:public');
    expect(text).toContain('UNLICENSED');
    expect(text).not.toMatch(/\]\((?:30-业务资料库|90-版本复盘摘要|20-执行文件)\//);
  }
});
