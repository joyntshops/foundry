import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';
import { createGitHubApp, loadPrivateKey, GitHubError } from './github.js';

let pkcs1Pem: string;
let pkcs8Pem: string;
let publicPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

type Call = { url: string; init: RequestInit };

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return new Response('not found', { status: 404 });
    return route(init ?? {});
  }) as typeof fetch;
}

describe('loadPrivateKey', () => {
  it('accepts the PKCS#1 PEM GitHub downloads and PKCS#8', () => {
    expect(loadPrivateKey(pkcs1Pem).type).toBe('private');
    expect(loadPrivateKey(pkcs8Pem).type).toBe('private');
    expect(loadPrivateKey('  ' + pkcs1Pem.trim() + '  ').type).toBe('private');
  });
});

describe('createGitHubApp', () => {
  it('looks up the installation with an App JWT signed by the key, issuer = app id', async () => {
    const calls: Call[] = [];
    const gh = createGitHubApp({
      appId: '4242',
      privateKeyPem: pkcs1Pem,
      apiUrl: 'https://api.example.test/',
      fetch: fakeFetch({ 'GET /repos/acme/widgets/installation': () => Response.json({ id: 777 }) }, calls),
    });

    expect(await gh.findInstallation('acme/widgets')).toEqual({ id: 777 });
    expect(calls[0].url).toBe('https://api.example.test/repos/acme/widgets/installation');

    const headers = calls[0].init.headers as Record<string, string>;
    const jwt = headers.Authorization.replace(/^Bearer /, '');
    const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(publicPem, 'RS256'), { issuer: '4242' });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.iss).toBe('4242');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(10 * 60);
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('joynt-foundry-broker');
  });

  it('returns null when the App is not installed on the repository', async () => {
    const gh = createGitHubApp({ appId: '1', privateKeyPem: pkcs8Pem, fetch: fakeFetch({}, []) });
    expect(await gh.findInstallation('acme/nope')).toBeNull();
  });

  it('throws on any other lookup failure, with the status', async () => {
    const gh = createGitHubApp({
      appId: '1',
      privateKeyPem: pkcs8Pem,
      fetch: fakeFetch({ 'GET /repos/acme/widgets/installation': () => new Response('bad creds', { status: 401 }) }, []),
    });
    await expect(gh.findInstallation('acme/widgets')).rejects.toBeInstanceOf(GitHubError);
    await expect(gh.findInstallation('acme/widgets')).rejects.toMatchObject({ status: 401, operation: 'installation lookup' });
  });

  it('mints a token restricted to the one repository and forwards permissions', async () => {
    const calls: Call[] = [];
    const gh = createGitHubApp({
      appId: '1',
      privateKeyPem: pkcs1Pem,
      fetch: fakeFetch(
        {
          'POST /app/installations/777/access_tokens': () =>
            Response.json({ token: 'ghs_x', expires_at: '2026-11-03T13:00:00Z', permissions: { contents: 'write' } }, { status: 201 }),
        },
        calls,
      ),
    });

    const minted = await gh.mintToken(777, 'widgets', { contents: 'write' });
    expect(minted).toEqual({ token: 'ghs_x', expires_at: '2026-11-03T13:00:00Z', permissions: { contents: 'write' } });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ repositories: ['widgets'], permissions: { contents: 'write' } });
    expect(calls[0].url).toBe('https://api.github.com/app/installations/777/access_tokens');
  });

  it('throws when the mint does not answer 201', async () => {
    const gh = createGitHubApp({
      appId: '1',
      privateKeyPem: pkcs1Pem,
      fetch: fakeFetch({ 'POST /app/installations/777/access_tokens': () => new Response('nope', { status: 422 }) }, []),
    });
    await expect(gh.mintToken(777, 'widgets')).rejects.toMatchObject({ status: 422, operation: 'token mint' });
  });

  it('reuses the App JWT across calls inside its lifetime', async () => {
    const calls: Call[] = [];
    let t = 1_700_000_000_000;
    const gh = createGitHubApp({
      appId: '1',
      privateKeyPem: pkcs1Pem,
      now: () => t,
      fetch: fakeFetch({ 'GET /repos/acme/widgets/installation': () => Response.json({ id: 1 }) }, calls),
    });
    await gh.findInstallation('acme/widgets');
    t += 60_000;
    await gh.findInstallation('acme/widgets');
    t += 8 * 60_000;
    await gh.findInstallation('acme/widgets');
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).Authorization);
    expect(auth[0]).toBe(auth[1]);
    expect(auth[2]).not.toBe(auth[0]);
  });
});
