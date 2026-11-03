import { describe, it, expect } from 'vitest';
import { toHttpRequest, toFunctionUrlResult, handler } from './lambda.js';

describe('function URL adapter', () => {
  it('maps a payload-2.0 event, decoding a base64 body', () => {
    const req = toHttpRequest({
      rawPath: '/token',
      requestContext: { http: { method: 'POST' } },
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"oidc_token":"abc"}').toString('base64'),
      isBase64Encoded: true,
    });
    expect(req).toEqual({ method: 'POST', path: '/token', headers: { 'content-type': 'application/json' }, body: '{"oidc_token":"abc"}' });
  });

  it('defaults to GET / with no body', () => {
    expect(toHttpRequest({})).toEqual({ method: 'GET', path: '/', headers: {}, body: '' });
  });

  it('maps the response', () => {
    expect(toFunctionUrlResult({ status: 201, headers: { a: 'b' }, body: 'x' })).toEqual({ statusCode: 201, headers: { a: 'b' }, body: 'x' });
  });

  it('serves the health check without configuration or secrets', async () => {
    const res = await handler({ rawPath: '/healthz', requestContext: { http: { method: 'GET' } } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, disabled: false });
  });

  it('honours the kill switch before loading anything', async () => {
    process.env.BROKER_DISABLED = '1';
    try {
      const res = await handler({ rawPath: '/token', requestContext: { http: { method: 'POST' } }, body: '{"oidc_token":"x"}' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe('disabled');
    } finally {
      delete process.env.BROKER_DISABLED;
    }
  });

  it('answers 500 when it cannot load its configuration', async () => {
    delete process.env.GITHUB_APP_ID;
    const res = await handler({ rawPath: '/token', requestContext: { http: { method: 'POST' } }, body: '{"oidc_token":"x"}' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('broker_misconfigured');
  });
});
