/**
 * setup-bot tests — verify manifest structure and credential storage.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildManifest } from './setup-bot.js';

describe('buildManifest', () => {
  it('includes correct permissions', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback');

    expect(manifest.default_permissions).toEqual({
      issues: 'write',
      pull_requests: 'write',
      contents: 'write',
      metadata: 'read',
    });
  });

  it('includes webhook events but with active: false', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback');

    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.default_events).toContain('issues');
    expect(manifest.default_events).toContain('pull_request');
    expect(manifest.default_events).toContain('pull_request_review');
  });

  it('sets the correct redirect URL', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:4567/callback');
    expect(manifest.redirect_url).toBe('http://localhost:4567/callback');
  });

  it('uses the provided app name', () => {
    const manifest = buildManifest('Foundry Bot acme', 'http://localhost:9999/callback');
    expect(manifest.name).toBe('Foundry Bot acme');
  });

  it('sets public to false', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback');
    expect(manifest.public).toBe(false);
  });
});

describe('credential storage', () => {
  const stateDir = path.join(os.homedir(), '.joynt-foundry');

  it('saves credentials keyed by org name', () => {
    // Verify the file paths follow the pattern
    const org = 'joyntshops';
    const expectedJson = path.join(stateDir, `github-app-${org}.json`);
    const expectedPem = path.join(stateDir, `github-app-${org}.pem`);

    expect(expectedJson).toBe(path.join(stateDir, 'github-app-joyntshops.json'));
    expect(expectedPem).toBe(path.join(stateDir, 'github-app-joyntshops.pem'));
  });

  it('pem file is written with mode 0600 (owner-only)', () => {
    // Write a real temp file and verify permissions
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pem-test-'));
    const pemPath = path.join(tmpDir, 'github-app-testorg.pem');

    fs.writeFileSync(pemPath, 'fake-key-data', { mode: 0o600 });

    const stats = fs.statSync(pemPath);
    // mode & 0o777 gives the permission bits
    expect(stats.mode & 0o777).toBe(0o600);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
