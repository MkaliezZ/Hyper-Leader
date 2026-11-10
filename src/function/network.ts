import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { AppError, invariant } from '../../server/errors.js';

export interface PublicResponse { url: string; status: number; mime: string; data: Buffer; headers: Record<string, string | string[] | undefined> }
export type PublicReader = (url: string, signal?: AbortSignal) => Promise<PublicResponse>;
export function publicAddress(address: string) { try { let parsed = ipaddr.parse(address.replace(/^\[|\]$/g, '')); if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address(); return parsed.range() === 'unicast'; } catch { return false; } }
export function publicUrl(raw: string): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new AppError(400, '请输入完整的 HTTP(S) 来源地址。', 'SOURCE_BAD_URL'); }
  invariant(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 400, '来源只支持不含凭据的公开 HTTP(S) 地址。', 'SOURCE_BAD_URL');
  invariant(!url.port || url.port === '80' || url.port === '443', 400, '公开来源只接受标准 Web 端口；内部资料请上传文件。', 'SOURCE_PORT');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  invariant(host && host !== 'localhost' && !/\.(localhost|local|internal|home|lan)$/.test(host), 403, '不能读取本机或内网来源，内部资料可通过上传提供。', 'SOURCE_NETWORK_SCOPE');
  if (net.isIP(host)) invariant(publicAddress(host), 403, '不能读取本机、内网或保留地址。', 'SOURCE_NETWORK_SCOPE');
  for (const key of url.searchParams.keys()) invariant(!/^(api[_-]?key|access[_-]?token|authorization|password|passwd|secret)$/i.test(key), 400, '来源网址不能携带密钥或密码，请使用无凭据的公开链接。', 'SOURCE_URL_SECRET');
  invariant(!/(?:api[_-]?key|access[_-]?token|authorization|password|secret)=/i.test(url.hash), 400, '来源的页内路由不能携带凭据。', 'SOURCE_URL_SECRET');
  return url;
}
export function sourceKey(raw: string) { const url = publicUrl(raw); for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || /^(gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key); url.searchParams.sort(); return url.href; }
export async function safeRead(raw: string, signal?: AbortSignal, lookup = dns.lookup): Promise<PublicResponse> {
  let url = publicUrl(raw);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal?.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const pending = net.isIP(host) ? Promise.resolve([{ address: host, family: net.isIP(host) }]) : lookup(host, { all: true });
    const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      let finished = false;
      const finish = (fn: (value: any) => void, value: any) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
      const abort = () => finish(reject, new AppError(409, '来源解析已中断。', 'SOURCE_CANCELLED'));
      const timer = setTimeout(() => finish(reject, new AppError(504, '来源域名解析超时。', 'SOURCE_DNS_TIMEOUT')), 10000);
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(pending).then(value => finish(resolve, value), error => finish(reject, error));
    });
    invariant(addresses.length && addresses.every(row => publicAddress(row.address)), 403, '来源解析到内网或保留地址，已阻止读取。', 'SOURCE_NETWORK_SCOPE');
    const selected = addresses.find(row => row.family === 4) ?? addresses[0];
    const response = await new Promise<PublicResponse>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', signal, timeout: 18000, headers: { 'User-Agent': 'HyperLeader/0.1 (+public-read-only)', Accept: 'text/html,application/rss+xml,application/xml,application/pdf,text/plain;q=0.9,*/*;q=0.3', 'Accept-Encoding': 'identity' }, lookup: (_hostname: string, options: any, callback: any) => { if (options?.all) callback(null, [selected]); else callback(null, selected.address, selected.family); } }, stream => {
        const chunks: Buffer[] = []; let size = 0;
        stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 12 * 1024 * 1024) stream.destroy(new AppError(413, '网页或附件超过12 MiB读取上限。', 'SOURCE_TOO_LARGE')); else chunks.push(chunk); });
        stream.on('error', reject); stream.on('end', () => resolve({ url: url.href, status: stream.statusCode ?? 500, mime: String(stream.headers['content-type'] ?? '').split(';')[0].trim(), data: Buffer.concat(chunks), headers: stream.headers }));
      });
      request.on('timeout', () => request.destroy(new AppError(504, '来源读取超时，可以稍后重试或上传正文。', 'SOURCE_TIMEOUT'))); request.on('error', reject); request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) { invariant(redirects < 5, 400, '来源重定向过多。'); url = publicUrl(new URL(String(response.headers.location), url).href); continue; }
    return response;
  }
  throw new AppError(400, '来源重定向过多。');
}
