import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { PublicSettings } from '../shared/types.js';
import { DSH_VERSION } from '../src/judgment/policy.js';
import { AppError } from './errors.js';
import { atomicJson, jsonFile } from './files.js';

const Input = z.object({ model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/), baseUrl: z.string().url().max(1000), maxTokens: z.number().int().min(1024).max(32768), maxSteps: z.number().int().min(4).max(60), maxMinutes: z.number().int().min(1).max(30), searchProvider: z.enum(['none', 'bing-rss']), apiKey: z.string().trim().max(2000).optional(), clearKey: z.boolean().optional() }).strict();
type Stored = Omit<PublicSettings, 'hasKey' | 'keySource' | 'dataHome' | 'pythonReady' | 'dshVersion'> & { keyCipher?: string };
export function modelUrl(raw: string) { const url = new URL(raw); if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new AppError(400, '模型地址不能含凭据、查询参数或片段。'); if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new AppError(400, '非本机模型服务必须使用 HTTPS。'); return url.href.replace(/\/+$/, ''); }
export class Config {
  readonly home: string;
  private saved!: Stored;
  private secret!: Buffer;
  constructor(readonly root: string, home?: string) { this.home = path.resolve(home ?? process.env.HYPER_LEADER_HOME ?? path.join(root, '.local')); }
  python() { return process.env.HYPER_LEADER_PYTHON ?? path.join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  async init() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    this.saved = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', maxTokens: 8192, maxSteps: 30, maxMinutes: 15, searchProvider: 'none', protocol: 'deepseek-messages', ...await jsonFile<Partial<Stored>>(path.join(this.home, 'settings.json'), {}) };
    this.saved.baseUrl = modelUrl(this.saved.baseUrl);
    const file = path.join(this.home, 'credential-key.bin');
    try { this.secret = await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.secret = randomBytes(32); await writeFile(file, this.secret, { flag: 'wx', mode: 0o600 }); }
    if (this.secret.length !== 32) throw new Error('凭据存储损坏，请保留数据目录并检查备份。');
  }
  key() { if (!this.saved.keyCipher) return process.env.HYPER_LEADER_API_KEY?.trim() ?? ''; const bytes = Buffer.from(this.saved.keyCipher, 'base64'); const cipher = createDecipheriv('aes-256-gcm', this.secret, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); }
  async public(): Promise<PublicSettings> { const { keyCipher: _secret, ...values } = this.saved; return { ...values, dshVersion: DSH_VERSION, dataHome: this.home, hasKey: !!(this.saved.keyCipher || process.env.HYPER_LEADER_API_KEY), keySource: this.saved.keyCipher ? 'saved' : process.env.HYPER_LEADER_API_KEY ? 'environment' : 'none', pythonReady: !!(await stat(this.python()).catch(() => null))?.isFile() }; }
  async save(raw: unknown) { const input = Input.parse(raw); let keyCipher = input.clearKey ? undefined : this.saved.keyCipher; if (input.apiKey) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.secret, iv); const data = Buffer.concat([cipher.update(input.apiKey), cipher.final()]); keyCipher = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); } const { apiKey: _key, clearKey: _clear, ...values } = input; this.saved = { ...values, protocol: 'deepseek-messages', baseUrl: modelUrl(values.baseUrl), keyCipher }; await atomicJson(path.join(this.home, 'settings.json'), this.saved); return this.public(); }
}
