import { describe, it, expect, beforeAll } from 'vitest';
import { handleRequest, readOidcToken, type HttpRequest } from './http.js';
import { fakeIssuer, fakeGitHub, baseConfig, deps, type FakeIssuer } from './test-helpers.js';

let issuer: FakeIssuer;
beforeAll(async () => {
  issuer = await fakeIssuer();
});

const req = (over: Partial<HttpRequest>): HttpRequest => ({ method: 'GET', path: '/', headers: {}, body: '', ...over });

describe('handleRequest', () => {
  it('answers the health check without secrets', async () => {
    const res = await handleRequest(req({ path: '/healthz' }), baseConfig(), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, disabled: false });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('reports the kill switch on the health check', async () => {
    const res = await handleRequest(req({ path: '/healthz/' }), baseConfig({ disabled: true }), deps(issuer, fakeGitHub(), []));
    expect(JSON.parse(res.body)).toEqual({ ok: true, disabled: true });
  });

  it('exchanges a token sent as a JSON body', async () => {
    const body = JSON.stringify({ oidc_token: await issuer.sign() });
    const res = await handleRequest(req({ method: 'POST', path: '/token', body }), baseConfig(), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ repository: 'acme/widgets', installation_id: 777 });
    expect(res.headers['Content-Type']).toBe('application/json');
  });

  it('exchanges a token sent as a Bearer header', async () => {
    const headers = { Authorization: `Bearer ${await issuer.sign()}` };
    const res = await handleRequest(req({ method: 'POST', path: '/token', headers }), baseConfig(), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(200);
  });

  it('answers 400 when no token is sent', async () => {
    for (const body of ['', '{}', 'not json', '{"oidc_token": 5}']) {
      const res = await handleRequest(req({ method: 'POST', path: '/token', body }), baseConfig(), deps(issuer, fakeGitHub(), []));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe('missing_token');
    }
  });

  it('answers 405 for the wrong method and 404 for unknown paths', async () => {
    const d = deps(issuer, fakeGitHub(), []);
    expect((await handleRequest(req({ method: 'GET', path: '/token' }), baseConfig(), d)).status).toBe(405);
    expect((await handleRequest(req({ method: 'POST', path: '/healthz' }), baseConfig(), d)).status).toBe(405);
    expect((await handleRequest(req({ path: '/' }), baseConfig(), d)).status).toBe(404);
    expect((await handleRequest(req({ path: '/tokens' }), baseConfig(), d)).status).toBe(404);
  });
});

describe('readOidcToken', () => {
  it('prefers the Authorization header, case-insensitively', () => {
    expect(readOidcToken(req({ headers: { authorization: 'bearer abc' }, body: '{"oidc_token":"def"}' }))).toBe('abc');
    expect(readOidcToken(req({ headers: { Authorization: 'Basic abc' }, body: '{"oidc_token":"def"}' }))).toBe('def');
  });
});
