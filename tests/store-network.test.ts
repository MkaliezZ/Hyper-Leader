import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Store } from '../src/asset/store.js';
import { publicAddress, publicUrl, sourceKey, safeRead } from '../src/function/network.js';
import { rejectLocalReferences } from '../src/function/workers.js';
import { restrictedPatch, runtimeEnvironment } from '../src/function/runtime.js';

describe('persistence and boundaries', () => {
  it('preserves revisions, rejects stale writes and rolls back a transaction', async () => {
    const parent = path.join(os.tmpdir(), 'opencode'); await mkdir(parent, { recursive: true }); const home = await mkdtemp(path.join(parent, 'hyper-leader-store-')); const store = new Store(home);
    try { const first = store.create<any>('item', { title: '原版', spaceId: 'space' }); const second = store.update<any>('item', first.id, row => { row.title = '新版'; }, 1); expect(second.version).toBe(2); expect(store.at<any>('item', first.id, 1).title).toBe('原版'); expect(() => store.update('item', first.id, () => undefined, 1)).toThrow(/版本/); expect(() => store.transaction(() => { store.create<any>('item', { title: '应回滚' }); throw new Error('rollback'); })).toThrow('rollback'); expect(store.list('item')).toHaveLength(1); } finally { store.close(); await rm(home, { recursive: true, force: true }); }
  });
  it.each(['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1'])('blocks non-public address %s', address => expect(publicAddress(address)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', address => expect(publicAddress(address)).toBe(true));
  it.each(['http://localhost/', 'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://192.168.1.1/', 'https://service.local/', 'https://user:password@example.com', 'file:///C:/secret', 'https://example.com:8080/', 'https://example.com/?api_key=secret'])('rejects unsafe source URL %s', url => expect(() => publicUrl(url)).toThrow());
  it('retains meaningful query parameters and SPA routes while normalizing tracking-only variants', () => { expect(publicUrl('https://example.com/?batch=2#/declare').href).toBe('https://example.com/?batch=2#/declare'); expect(sourceKey('https://example.com/?batch=2&utm_source=x')).toBe(sourceKey('https://example.com/?batch=2')); expect(sourceKey('https://example.com/?batch=1')).not.toBe(sourceKey('https://example.com/?batch=2')); expect(sourceKey('https://example.com/#/a')).not.toBe(sourceKey('https://example.com/#/b')); });
  it('checks every DNS answer before opening a socket', async () => { const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]); await expect(safeRead('https://public.test/', undefined, lookup as any)).rejects.toThrow(/内网/); });
  it('revalidates a redirect to a private address', async () => {
    const spy = vi.spyOn(https, 'request').mockImplementation(((_url: any, options: any, callback: any) => { const request = new EventEmitter() as any; request.end = () => { const response = Readable.from([Buffer.from('redirect')]) as any; response.statusCode = 302; response.headers = { location: 'http://127.0.0.1/private' }; callback(response); }; request.destroy = () => request; return request; }) as any);
    try { await expect(safeRead('https://public.test/', undefined, (async () => [{ address: '8.8.8.8', family: 4 }]) as any)).rejects.toThrow(/本机|内网/); expect(spy).toHaveBeenCalledTimes(1); } finally { spy.mockRestore(); }
  });
  it.each([{ source: 'file:///C:/private.txt' }, { nested: { source: 'C:\\private\\file.md' } }, ['../other-project/file'], { source: '/etc/passwd' }])('rejects local paths hidden in domain data', data => expect(() => rejectLocalReferences(data)).toThrow(/本机/));
  it('disables unscoped DSH capabilities and does not inherit unrelated environment secrets', () => { const patch = restrictedPatch({ model: 'deepseek-flash', baseUrl: 'https://example.com', maxTokens: 2048 }); expect(patch.find((row: any) => row.id === 'persistent-pwsh')).toMatchObject({ disabled: true }); expect(patch.find((row: any) => row.id === 'session-log-deepseek')).toMatchObject({ disabled: true }); expect(patch.find((row: any) => row.id === 'tool-fs')).toMatchObject({ config: { read: false, write: false, edit: false, readImage: false } }); const before = process.env.UNRELATED_TEST_SECRET; process.env.UNRELATED_TEST_SECRET = 'do-not-copy'; try { expect(runtimeEnvironment('fixture-key')).not.toHaveProperty('UNRELATED_TEST_SECRET'); expect(runtimeEnvironment('fixture-key').DEEPSEEK_API_KEY).toBe('fixture-key'); } finally { if (before === undefined) delete process.env.UNRELATED_TEST_SECRET; else process.env.UNRELATED_TEST_SECRET = before; } });
});
