let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers); if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-CSRF-Token', csrf);
  if (init.method && !['GET', 'HEAD'].includes(init.method) && !(init.body instanceof FormData) && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', crypto.randomUUID());
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const value = await response.json().catch(() => ({ error: { message: '服务未返回有效结果。' } }));
  if (!response.ok) throw new Error(value?.error?.message ?? `请求失败：${response.status}`); return value as T;
}
export function send(path: string, body: unknown, method = 'POST') { return api(path, { method, body: JSON.stringify(body) }); }
export function assetUrl(reference: { asset_id: string; version: string }) { return `/api/v1/assets/${encodeURIComponent(reference.asset_id)}/versions/${encodeURIComponent(reference.version)}/download`; }
