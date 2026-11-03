/**
 * HTTP surface, independent of the hosting platform.
 *
 *   GET  /healthz   → 200 {"ok":true,"disabled":false}
 *   POST /token     → the exchange. The OIDC token comes as JSON {"oidc_token":"..."}
 *                     or as `Authorization: Bearer <jwt>`.
 */
import { exchange, type BrokerConfig, type BrokerDeps } from './core.js';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function readOidcToken(req: HttpRequest): string | null {
  const auth = headerValue(req.headers, 'authorization');
  const bearer = auth?.match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1];
  if (!req.body) return null;
  try {
    const parsed: unknown = JSON.parse(req.body);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { oidc_token?: unknown }).oidc_token === 'string') {
      return (parsed as { oidc_token: string }).oidc_token;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export async function handleRequest(req: HttpRequest, cfg: BrokerConfig, deps: BrokerDeps): Promise<HttpResponse> {
  const path = req.path.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (path === '/healthz') {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
    return json(200, { ok: true, disabled: cfg.disabled });
  }

  if (path === '/token') {
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const token = readOidcToken(req);
    if (!token) {
      return json(400, { error: 'missing_token', message: 'Send the OIDC token as JSON {"oidc_token": "..."} or as a Bearer Authorization header.' });
    }
    const result = await exchange(token, cfg, deps);
    return json(result.status, result.body);
  }

  return json(404, { error: 'not_found' });
}
