import { describe, it, expect, beforeAll } from 'vitest';
import { exchange, isDenied, type AuditEntry } from './core.js';
import { fakeIssuer, fakeGitHub, baseConfig, deps, type FakeIssuer } from './test-helpers.js';

let issuer: FakeIssuer;
beforeAll(async () => {
  issuer = await fakeIssuer();
});

describe('exchange', () => {
  it('mints a token scoped to the calling repository and logs an allow', async () => {
    const gh = fakeGitHub();
    const log: AuditEntry[] = [];
    const res = await exchange(await issuer.sign(), baseConfig(), deps(issuer, gh, log));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token: 'ghs_minted_777_widgets', expires_at: '2026-11-03T12:00:00Z', repository: 'acme/widgets', installation_id: 777, app_slug: 'joynt-foundry' });
    expect(gh.mints).toEqual([{ installationId: 777, repositoryName: 'widgets', permissions: undefined }]);
    expect(log).toEqual([
      expect.objectContaining({
        event: 'exchange', decision: 'allow', reason: 'ok', status: 200,
        repository: 'acme/widgets', repository_id: '12345', repository_owner: 'acme', installation_id: 777,
        workflow_ref: 'acme/widgets/.github/workflows/foundry.yml@refs/heads/main', run_id: '98765', actor: 'octocat',
      }),
    ]);
  });

  it('never writes the minted token to the log', async () => {
    const gh = fakeGitHub();
    const log: AuditEntry[] = [];
    await exchange(await issuer.sign(), baseConfig(), deps(issuer, gh, log));
    expect(JSON.stringify(log)).not.toContain('ghs_minted');
  });

  it('passes the configured permission narrowing to the mint', async () => {
    const gh = fakeGitHub();
    const perms = { contents: 'write', issues: 'write' };
    const res = await exchange(await issuer.sign(), baseConfig({ tokenPermissions: perms }), deps(issuer, gh, []));
    expect(res.status).toBe(200);
    expect(gh.mints[0].permissions).toEqual(perms);
    expect(res.body.permissions).toEqual(perms);
  });

  describe('refuses a token that does not verify', () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ['wrong audience', () => issuer.sign({}, { audience: 'someone-else' })],
      ['wrong issuer', () => issuer.sign({}, { issuer: 'https://evil.example' })],
      ['expired', () => issuer.sign({}, { expiresIn: '-1m' })],
      ['unknown key', () => issuer.signWithStrangerKey()],
      ['unknown kid', () => issuer.sign({}, { kid: 'nope' })],
      ['garbage', async () => 'not.a.jwt'],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        const gh = fakeGitHub();
        const log: AuditEntry[] = [];
        const res = await exchange(await make(), baseConfig(), deps(issuer, gh, log));
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_jwt');
        expect(gh.mints).toEqual([]);
        expect(log[0]).toMatchObject({ decision: 'deny', reason: 'invalid_jwt', status: 401 });
        expect(log[0].error).toBeTruthy();
      });
    }
  });

  it('rejects an algorithm other than RS256 even with a known key', async () => {
    // A token whose header claims HS256 with the public key as the secret must not verify.
    const [header, payload] = (await issuer.sign()).split('.');
    const forgedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'test-key-1' })).toString('base64url');
    const res = await exchange(`${forgedHeader}.${payload}.AAAA`, baseConfig(), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(401);
    void header;
  });

  it('rejects a token without a repository claim', async () => {
    const res = await exchange(await issuer.sign({ repository: undefined }), baseConfig(), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_claims');
  });

  it('rejects a repository claim that is not owner/name', async () => {
    const res = await exchange(await issuer.sign({ repository: 'acme/widgets/../other' }), baseConfig(), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(400);
  });

  it('rejects a repository_owner that disagrees with repository', async () => {
    const log: AuditEntry[] = [];
    const res = await exchange(await issuer.sign({ repository_owner: 'other' }), baseConfig(), deps(issuer, fakeGitHub(), log));
    expect(res.status).toBe(400);
    expect(log[0]).toMatchObject({ reason: 'missing_claims', repository: 'acme/widgets' });
  });

  it('denies an owner on the deny-list before touching GitHub', async () => {
    const gh = fakeGitHub();
    gh.failLookup = new Error('should not be called');
    const log: AuditEntry[] = [];
    const res = await exchange(await issuer.sign(), baseConfig({ denyList: ['ACME'] }), deps(issuer, gh, log));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('deny_list');
    expect(log[0]).toMatchObject({ decision: 'deny', reason: 'deny_list', repository: 'acme/widgets' });
  });

  it('denies a repository on the deny-list, case-insensitively', async () => {
    const res = await exchange(await issuer.sign(), baseConfig({ denyList: ['other/thing', 'Acme/Widgets'] }), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(403);
  });

  it('does not deny a sibling repository of a denied one', async () => {
    const res = await exchange(await issuer.sign(), baseConfig({ denyList: ['acme/other'] }), deps(issuer, fakeGitHub(), []));
    expect(res.status).toBe(200);
  });

  it('enforces the workflow ref pattern when one is configured', async () => {
    const cfg = baseConfig({ workflowRefPattern: /\/\.github\/workflows\/foundry\.yml@/ });
    const ok = await exchange(await issuer.sign(), cfg, deps(issuer, fakeGitHub(), []));
    expect(ok.status).toBe(200);

    const log: AuditEntry[] = [];
    const bad = await exchange(await issuer.sign({ job_workflow_ref: 'acme/widgets/.github/workflows/other.yml@refs/heads/main' }), cfg, deps(issuer, fakeGitHub(), log));
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('workflow_ref');
    expect(log[0]).toMatchObject({ reason: 'workflow_ref', workflow_ref: 'acme/widgets/.github/workflows/other.yml@refs/heads/main' });

    const missing = await exchange(await issuer.sign({ job_workflow_ref: undefined }), cfg, deps(issuer, fakeGitHub(), []));
    expect(missing.status).toBe(403);
  });

  it('refuses a repository where the App is not installed', async () => {
    const gh = fakeGitHub({ 'acme/other': 1 });
    const log: AuditEntry[] = [];
    const res = await exchange(await issuer.sign(), baseConfig(), deps(issuer, gh, log));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_installed');
    expect(gh.mints).toEqual([]);
    expect(log[0]).toMatchObject({ reason: 'not_installed', repository: 'acme/widgets' });
  });

  it('answers 503 when disabled, without verifying anything', async () => {
    const log: AuditEntry[] = [];
    const res = await exchange('whatever', baseConfig({ disabled: true }), deps(issuer, fakeGitHub(), log));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('disabled');
    expect(log[0]).toMatchObject({ reason: 'disabled', status: 503 });
  });

  it('turns a GitHub failure into 502 with the error in the log, not the body', async () => {
    const gh = fakeGitHub();
    gh.failMint = new Error('token mint failed with 500: boom');
    const log: AuditEntry[] = [];
    const res = await exchange(await issuer.sign(), baseConfig(), deps(issuer, gh, log));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'github_error', message: 'GitHub did not mint a token.' });
    expect(log[0]).toMatchObject({ reason: 'github_error', status: 502, repository: 'acme/widgets' });
    expect(log[0].error).toContain('boom');

    gh.failMint = undefined;
    gh.failLookup = new Error('lookup down');
    const res2 = await exchange(await issuer.sign(), baseConfig(), deps(issuer, gh, []));
    expect(res2.status).toBe(502);
  });
});

describe('isDenied', () => {
  it('matches owners and owner/repo entries, ignoring case and blanks', () => {
    expect(isDenied('Acme/Widgets', ['acme'])).toBe(true);
    expect(isDenied('acme/widgets', ['ACME/WIDGETS'])).toBe(true);
    expect(isDenied('acme/widgets', ['', ' ', 'acme/other'])).toBe(false);
    expect(isDenied('acme/widgets', ['acmecorp'])).toBe(false);
  });
});
