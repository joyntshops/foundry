/**
 * Preview verification against a real local HTTP server and real commands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import { waitForUrl, verifyPreview, formatPreviewVerify, isConfigured } from './preview-verify.js';
import { DEFAULTS } from '../config.js';
import type { FoundryConfig } from '../types.js';

let server: http.Server;
let base: string;
/** Per-path behaviour: how many requests to 404 before answering 200. */
const flaky = new Map<string, number>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const left = flaky.get(req.url ?? '') ?? 0;
    if (left > 0) {
      flaky.set(req.url ?? '', left - 1);
      res.writeHead(404, { connection: 'close' }); res.end('not yet');
      return;
    }
    if (req.url === '/boom') { res.writeHead(500, { connection: 'close' }); res.end('err'); return; }
    res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }); res.end('<h1>Hello World</h1>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));

const cfg = (verify_preview: string[], ready_timeout_seconds = 2): FoundryConfig => ({
  ...DEFAULTS, repo: 'o/r', verify_preview,
  preview: { mode: 'template', url_template: 'https://x', ready_timeout_seconds },
});

describe('waitForUrl', () => {
  it('returns ready on the first 200', async () => {
    const r = await waitForUrl(`${base}/ok`, 2000, 10);
    expect(r).toEqual({ ready: true, status: 200, attempts: 1 });
  });

  it('keeps polling through 404s until the page appears', async () => {
    flaky.set('/later', 2);
    const r = await waitForUrl(`${base}/later`, 5000, 10);
    expect(r.ready).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it('gives up at the deadline on persistent 5xx', async () => {
    const r = await waitForUrl(`${base}/boom`, 150, 20);
    expect(r.ready).toBe(false);
    expect(r.status).toBe(500);
    expect(r.attempts).toBeGreaterThan(1);
  });

  it('treats connection refused as not ready', async () => {
    const r = await waitForUrl('http://127.0.0.1:1/nope', 100, 20);
    expect(r.ready).toBe(false);
    expect(r.status).toBeUndefined();
  });
});

describe('verifyPreview', () => {
  it('runs the commands with FOUNDRY_PREVIEW_URL set, in the given cwd', async () => {
    // Commands must not call back into the in-process server: execSync blocks
    // the event loop, so the server could never answer.
    const out = await verifyPreview(cfg(['echo "url=$FOUNDRY_PREVIEW_URL pr=$FOUNDRY_PR_NUMBER"', 'test -n "$FOUNDRY_PREVIEW_URL" && pwd']), {
      url: `${base}/ok`, cwd: os.tmpdir(), env: { FOUNDRY_PR_NUMBER: '7' },
    });
    expect(out.passed).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].output).toContain(`url=${base}/ok pr=7`);
  });

  it('fails fast on the first failing command', async () => {
    const out = await verifyPreview(cfg(['false', 'echo never']), { url: `${base}/ok`, cwd: os.tmpdir() });
    expect(out.passed).toBe(false);
    expect(out.results).toHaveLength(1);
  });

  it('reports a preview that never comes up as a failed wait step, running nothing', async () => {
    const out = await verifyPreview(cfg(['echo never'], 1), { url: 'http://127.0.0.1:1/', cwd: os.tmpdir() });
    expect(out.passed).toBe(false);
    expect(out.results[0].command).toMatch(/^wait for /);
    expect(out.results[0].output).toMatch(/did not answer within 1s/);
  });
});

describe('helpers', () => {
  it('isConfigured reflects verify_preview', () => {
    expect(isConfigured(cfg([]))).toBe(false);
    expect(isConfigured(cfg(['x']))).toBe(true);
    expect(isConfigured({ ...DEFAULTS, repo: 'o/r', verify_preview: undefined })).toBe(false);
  });

  it('formatPreviewVerify lists steps and shows failing output', () => {
    const text = formatPreviewVerify({ passed: false, url: 'https://p', results: [
      { command: 'a', success: true, output: '', duration_ms: 1 },
      { command: 'b', success: false, output: 'boom', duration_ms: 2 },
    ] });
    expect(text).toContain('**Preview verification FAILED** against https://p');
    expect(text).toContain('- `a`: passed (1ms)');
    expect(text).toContain('- `b`: FAILED (2ms)');
    expect(text).toContain('boom');
  });
});
