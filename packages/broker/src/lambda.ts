/**
 * AWS Lambda adapter: function URL event in, HTTP response out.
 *
 * The private key is read from Secrets Manager at cold start and re-read
 * after KEY_CACHE_SECONDS, so a rotated key takes effect without a redeploy.
 * The audit log is one JSON line per request on stdout, which CloudWatch
 * Logs keeps for as long as the log group's retention says.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createRemoteJWKSet } from 'jose';
import { configFromEnv, GITHUB_ACTIONS_JWKS_URL, type BrokerEnv } from './config.js';
import { createGitHubApp } from './github.js';
import { handleRequest, type HttpRequest, type HttpResponse } from './http.js';
import type { AuditEntry, BrokerDeps, BrokerConfig } from './core.js';

const KEY_CACHE_SECONDS = 5 * 60;

/** The subset of the Lambda function URL (payload format 2.0) event the adapter reads. */
export interface FunctionUrlEvent {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function toHttpRequest(event: FunctionUrlEvent): HttpRequest {
  const raw = event.body ?? '';
  const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  return {
    method: event.requestContext?.http?.method ?? 'GET',
    path: event.rawPath ?? '/',
    headers: event.headers ?? {},
    body,
  };
}

export function toFunctionUrlResult(res: HttpResponse): FunctionUrlResult {
  return { statusCode: res.status, headers: res.headers, body: res.body };
}

interface Runtime {
  cfg: BrokerConfig;
  deps: BrokerDeps;
  loadedAt: number;
}

let runtime: Runtime | null = null;

async function readPrivateKey(secretArn: string): Promise<string> {
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const pem = out.SecretString ?? (out.SecretBinary ? Buffer.from(out.SecretBinary).toString('utf8') : '');
  if (!pem.includes('PRIVATE KEY')) throw new Error(`Secret ${secretArn} does not hold a PEM private key`);
  return pem;
}

const jwks = createRemoteJWKSet(new URL(GITHUB_ACTIONS_JWKS_URL), {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000,
});

export function logEntry(entry: AuditEntry): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

async function getRuntime(env: BrokerEnv): Promise<Runtime> {
  const now = Date.now();
  if (runtime && now - runtime.loadedAt < KEY_CACHE_SECONDS * 1000) return runtime;

  const cfg = configFromEnv(env);
  const secretArn = (env.PRIVATE_KEY_SECRET_ARN ?? '').trim();
  if (!secretArn) throw new Error('PRIVATE_KEY_SECRET_ARN is not set');
  const privateKeyPem = await readPrivateKey(secretArn);

  runtime = {
    cfg,
    deps: {
      getKey: jwks,
      github: createGitHubApp({ appId: cfg.appId, privateKeyPem, apiUrl: env.GITHUB_API_URL }),
      log: logEntry,
    },
    loadedAt: now,
  };
  return runtime;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const req = toHttpRequest(event);

  // The kill switch and health check must work even when the secret cannot be read.
  if (req.path.replace(/\/+$/, '') === '/healthz' || /^(1|true|yes|on)$/i.test(process.env.BROKER_DISABLED ?? '')) {
    const cfg: BrokerConfig = {
      issuer: '',
      audience: '',
      denyList: [],
      disabled: /^(1|true|yes|on)$/i.test(process.env.BROKER_DISABLED ?? ''),
    };
    const deps: BrokerDeps = {
      getKey: jwks,
      github: { findInstallation: async () => null, mintToken: async () => { throw new Error('disabled'); }, appSlug: async () => '' },
      log: logEntry,
    };
    return toFunctionUrlResult(await handleRequest(req, cfg, deps));
  }

  let rt: Runtime;
  try {
    rt = await getRuntime(process.env as BrokerEnv);
  } catch (err) {
    logEntry({ event: 'exchange', decision: 'deny', reason: 'github_error', status: 500, error: `startup: ${String(err)}` });
    return toFunctionUrlResult({
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'broker_misconfigured', message: 'The broker could not load its configuration. See its log.' }),
    });
  }

  return toFunctionUrlResult(await handleRequest(req, rt.cfg, rt.deps));
}
