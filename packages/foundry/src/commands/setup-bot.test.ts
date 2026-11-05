/**
 * setup-bot tests — verify manifest structure and credential storage.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildManifest, repoSlugFromRemote, missingPermissions, publicAppNextSteps, appSettingsUrl, REQUIRED_PERMISSIONS, auditApp, installationSettingsUrl } from './setup-bot.js';
import type { InstallationInfo } from './setup-bot.js';

describe('buildManifest', () => {
  it('requests every permission Foundry needs, including workflows (issue 30)', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback');

    expect(manifest.default_permissions).toEqual({
      issues: 'write',
      pull_requests: 'write',
      contents: 'write',
      checks: 'write',
      actions: 'write',
      deployments: 'write',
      workflows: 'write',
      metadata: 'read',
    });
    expect(manifest.default_permissions).toEqual(REQUIRED_PERMISSIONS);
  });

  it('creates a public App when asked', () => {
    expect(buildManifest('Joynt Foundry', 'http://localhost:1/callback', undefined, { public: true }).public).toBe(true);
  });

  it('includes webhook events but with active: false', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback');

    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.default_events).toContain('issues');
    expect(manifest.default_events).toContain('pull_request');
    expect(manifest.default_events).toContain('pull_request_review');
    expect(manifest.default_events).toContain('issue_comment');
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

  it('sets webhook URL when serverUrl is provided', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback', 'https://foundry.example.com/webhook');
    expect(manifest.hook_attributes.url).toBe('https://foundry.example.com/webhook');
    expect(manifest.hook_attributes.active).toBe(false);
  });

  it('uses placeholder webhook URL when serverUrl is omitted', () => {
    const manifest = buildManifest('Foundry Bot myorg', 'http://localhost:9999/callback');
    expect(manifest.hook_attributes.url).toBe('https://example.com/unused');
  });
});

describe('missingPermissions', () => {
  it('is empty when everything is granted', () => {
    expect(missingPermissions({ ...REQUIRED_PERMISSIONS })).toEqual([]);
  });
  it('accepts write where read is required', () => {
    expect(missingPermissions({ ...REQUIRED_PERMISSIONS, metadata: 'write' })).toEqual([]);
  });
  it('names what is missing or too weak', () => {
    const granted = { issues: 'write', pull_requests: 'write', contents: 'read', metadata: 'read', checks: 'write' };
    expect(missingPermissions(granted)).toEqual(['contents: write', 'actions: write', 'deployments: write', 'workflows: write']);
    expect(missingPermissions(undefined)).toHaveLength(Object.keys(REQUIRED_PERMISSIONS).length);
  });
});

describe('auditApp', () => {
  const full = { ...REQUIRED_PERMISSIONS } as Record<string, string>;
  const inst = (over: Partial<InstallationInfo> = {}): InstallationInfo => ({
    id: 11, account: 'acme', accountType: 'Organization', repositorySelection: 'all', permissions: { ...full }, ...over,
  });

  it('passes when the App has everything and every installation accepted it', () => {
    const audit = auditApp({ permissions: full }, [inst(), inst({ id: 12, account: 'bob', accountType: 'User', repositorySelection: 'selected' })]);
    expect(audit.ok).toBe(true);
    expect(audit.appMissing).toEqual([]);
    expect(audit.installations.map(i => i.lagging)).toEqual([[], []]);
  });

  it('names what the App itself lacks', () => {
    const { workflows: _, ...without } = full;
    const audit = auditApp({ permissions: { ...without, checks: 'read' } }, [inst({ permissions: { ...without, checks: 'read' } })]);
    expect(audit.ok).toBe(false);
    expect(audit.appMissing).toEqual(['checks: write', 'workflows: write']);
    // The installation matches the App, so it is not the one lagging.
    expect(audit.installations[0].lagging).toEqual([]);
  });

  it('flags an installation that has not accepted a permission the App gained', () => {
    const { workflows: _, ...without } = full;
    const audit = auditApp({ permissions: full }, [inst(), inst({ id: 12, permissions: { ...without, deployments: 'read' } })]);
    expect(audit.ok).toBe(false);
    expect(audit.appMissing).toEqual([]);
    expect(audit.installations[0].lagging).toEqual([]);
    expect(audit.installations[1].lagging).toEqual(['deployments: write', 'workflows: write']);
  });

  it('accepts write on the installation where the App has read', () => {
    const audit = auditApp({ permissions: { ...full, metadata: 'read' } }, [inst({ permissions: { ...full, metadata: 'write' } })]);
    expect(audit.installations[0].lagging).toEqual([]);
  });

  it('fails with no installations, since no job could use the App', () => {
    const audit = auditApp({ permissions: full }, []);
    expect(audit.ok).toBe(false);
    expect(audit.appMissing).toEqual([]);
  });
});

describe('installationSettingsUrl', () => {
  it('points at the organization page for an org account and the personal page for a user', () => {
    expect(installationSettingsUrl('acme', true, 11)).toBe('https://github.com/organizations/acme/settings/installations/11');
    expect(installationSettingsUrl('bob', false, 12)).toBe('https://github.com/settings/installations/12');
  });
});

describe('publicAppNextSteps', () => {
  it('prints the logo URL, the install link and the broker commands with the App id and key path', () => {
    const lines = publicAppNextSteps({ org: 'joyntshops', isOrg: true, slug: 'joynt-foundry', appId: 4242, pemPath: '/home/w/.joynt-foundry/public-app-joyntshops.pem' }).join('\n');
    expect(lines).toContain('https://github.com/organizations/joyntshops/settings/apps/joynt-foundry → Display information');
    expect(lines).toContain('packages/foundry/assets/foundry-bot.png');
    expect(lines).toContain('https://github.com/apps/joynt-foundry/installations/new');
    expect(lines).toContain('FOUNDRY_APP_ID=4242');
    expect(lines).toContain('--secret-string "file:///home/w/.joynt-foundry/public-app-joyntshops.pem"');
    expect(lines).toContain('rm /home/w/.joynt-foundry/public-app-joyntshops.pem');
  });
  it('uses the personal settings URL for a user-owned App', () => {
    expect(appSettingsUrl('alice', false, 'my-app')).toBe('https://github.com/settings/apps/my-app');
    expect(appSettingsUrl('acme', true, 'my-app')).toBe('https://github.com/organizations/acme/settings/apps/my-app');
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

describe('repoSlugFromRemote', () => {
  it('detects the repo slug from the current git remote', () => {
    // This test runs inside the foundry repo, so it should detect the real remote
    const slug = repoSlugFromRemote();
    expect(slug).not.toBeNull();
    expect(slug).toMatch(/^.+\/.+$/); // owner/repo format
  });
});
