/**
 * The GitHub App client: an App JWT signed with the private key, the
 * installation lookup, and the token mint. `fetch` is injected for tests.
 */
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { GitHubApp, Installation, MintedToken } from './core.js';

export interface GitHubAppOptions {
  appId: string;
  /** PEM as downloaded from the App page (PKCS#1 "RSA PRIVATE KEY" or PKCS#8). */
  privateKeyPem: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    detail: string,
  ) {
    super(`${operation} failed with ${status}: ${detail}`);
  }
}

/** Load the PEM into a key object; accepts both encodings GitHub has shipped. */
export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.trim() + '\n');
}

const APP_JWT_LIFETIME_S = 9 * 60; // GitHub's maximum is 10 minutes
const APP_JWT_REUSE_S = 7 * 60;

export function createGitHubApp(opts: GitHubAppOptions): GitHubApp {
  const apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const key = loadPrivateKey(opts.privateKeyPem);

  let cached: { jwt: string; issuedAt: number } | null = null;

  async function appJwt(): Promise<string> {
    const nowS = Math.floor(now() / 1000);
    if (cached && nowS - cached.issuedAt < APP_JWT_REUSE_S) return cached.jwt;
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(nowS - 60) // clock skew, as GitHub recommends
      .setExpirationTime(nowS + APP_JWT_LIFETIME_S)
      .setIssuer(opts.appId)
      .sign(key);
    cached = { jwt, issuedAt: nowS };
    return jwt;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return doFetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await appJwt()}`,
        'User-Agent': 'joynt-foundry-broker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  return {
    async findInstallation(repository: string): Promise<Installation | null> {
      const res = await call('GET', `/repos/${repository}/installation`);
      if (res.status === 404) return null;
      if (!res.ok) throw new GitHubError(res.status, 'installation lookup', await safeText(res));
      const data = (await res.json()) as { id: number };
      return { id: data.id };
    },

    async mintToken(installationId: number, repositoryName: string, permissions?: Record<string, string>): Promise<MintedToken> {
      const res = await call('POST', `/app/installations/${installationId}/access_tokens`, {
        repositories: [repositoryName],
        ...(permissions ? { permissions } : {}),
      });
      if (res.status !== 201) throw new GitHubError(res.status, 'token mint', await safeText(res));
      const data = (await res.json()) as MintedToken;
      return { token: data.token, expires_at: data.expires_at, permissions: data.permissions };
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}
