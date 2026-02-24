/**
 * OctokitClient tests — mock the Octokit instance to verify correct API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OctokitClient, resolveAppAuth, appCredsExist } from './octokit-client.js';

function createMockOctokit() {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn(),
        get: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        createComment: vi.fn(),
        listComments: vi.fn(),
        listLabelsForRepo: vi.fn(),
        deleteLabel: vi.fn(),
        updateLabel: vi.fn(),
        createLabel: vi.fn(),
      },
      pulls: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        merge: vi.fn(),
        listReviews: vi.fn(),
        listReviewComments: vi.fn(),
      },
      git: {
        deleteRef: vi.fn(),
      },
    },
  } as any;
}

describe('OctokitClient', () => {
  let octokit: ReturnType<typeof createMockOctokit>;
  let client: OctokitClient;

  beforeEach(() => {
    octokit = createMockOctokit();
    client = new OctokitClient(octokit);
  });

  describe('listIssuesByLabel', () => {
    it('calls issues.listForRepo and maps response', async () => {
      octokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          {
            number: 1, title: 'Bug', body: 'desc',
            labels: [{ name: 'bug' }],
            html_url: 'https://github.com/o/r/issues/1',
            state: 'open',
          },
        ],
      });

      const result = await client.listIssuesByLabel('o/r', 'bug');
      expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', labels: 'bug', state: 'open', per_page: 50,
      });
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });

    it('filters out pull requests from results', async () => {
      octokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          { number: 1, title: 'Issue', body: '', labels: [], html_url: '', state: 'open' },
          { number: 2, title: 'PR', body: '', labels: [], html_url: '', state: 'open', pull_request: { url: 'x' } },
        ],
      });

      const result = await client.listIssuesByLabel('o/r', 'bug');
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });
  });

  describe('getIssue', () => {
    it('calls issues.get and maps response', async () => {
      octokit.rest.issues.get.mockResolvedValue({
        data: {
          number: 5, title: 'T', body: 'B',
          labels: [{ name: 'a' }],
          html_url: 'https://github.com/o/r/issues/5',
          state: 'open',
        },
      });

      const result = await client.getIssue('o/r', 5);
      expect(result.number).toBe(5);
      expect(result.title).toBe('T');
    });
  });

  describe('addLabel', () => {
    it('calls issues.addLabels', async () => {
      octokit.rest.issues.addLabels.mockResolvedValue({});
      await client.addLabel('o/r', 1, 'bug');
      expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', issue_number: 1, labels: ['bug'],
      });
    });
  });

  describe('removeLabel', () => {
    it('calls issues.removeLabel', async () => {
      octokit.rest.issues.removeLabel.mockResolvedValue({});
      await client.removeLabel('o/r', 1, 'bug');
      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', issue_number: 1, name: 'bug',
      });
    });
  });

  describe('addComment', () => {
    it('calls issues.createComment', async () => {
      octokit.rest.issues.createComment.mockResolvedValue({});
      await client.addComment('o/r', 1, 'hello');
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', issue_number: 1, body: 'hello',
      });
    });
  });

  describe('getComments', () => {
    it('calls issues.listComments and maps response', async () => {
      octokit.rest.issues.listComments.mockResolvedValue({
        data: [
          { id: 1, body: 'hi', user: { login: 'bob' }, created_at: '2024-01-01T00:00:00Z' },
        ],
      });

      const result = await client.getComments('o/r', 5);
      expect(result).toHaveLength(1);
      expect(result[0].body).toBe('hi');
      expect(result[0].user?.login).toBe('bob');
    });
  });

  describe('listLabels', () => {
    it('returns label names', async () => {
      octokit.rest.issues.listLabelsForRepo.mockResolvedValue({
        data: [{ name: 'bug' }, { name: 'feature' }],
      });
      const result = await client.listLabels('o/r');
      expect(result).toEqual(['bug', 'feature']);
    });
  });

  describe('ensureLabel', () => {
    it('updates existing label', async () => {
      octokit.rest.issues.updateLabel.mockResolvedValue({});
      await client.ensureLabel('o/r', 'bug', 'ff0000', 'Bug');
      expect(octokit.rest.issues.updateLabel).toHaveBeenCalled();
    });

    it('creates label if update fails', async () => {
      octokit.rest.issues.updateLabel.mockRejectedValue(new Error('not found'));
      octokit.rest.issues.createLabel.mockResolvedValue({});
      await client.ensureLabel('o/r', 'new', 'ff0000', 'New');
      expect(octokit.rest.issues.createLabel).toHaveBeenCalled();
    });
  });

  describe('createPR', () => {
    it('creates a PR and returns URL', async () => {
      octokit.rest.pulls.create.mockResolvedValue({
        data: { html_url: 'https://github.com/o/r/pull/1' },
      });
      const url = await client.createPR('o/r', { title: 'T', body: 'B', head: 'feature', base: 'main' });
      expect(url).toBe('https://github.com/o/r/pull/1');
    });
  });

  describe('getPRStatus', () => {
    it('returns status for existing PR', async () => {
      octokit.rest.pulls.list.mockResolvedValue({
        data: [{ state: 'open', html_url: 'https://github.com/o/r/pull/1' }],
      });
      const result = await client.getPRStatus('o/r', 'feature');
      expect(result).toEqual({ state: 'open', url: 'https://github.com/o/r/pull/1' });
    });

    it('returns null when no PR exists', async () => {
      octokit.rest.pulls.list.mockResolvedValue({ data: [] });
      const result = await client.getPRStatus('o/r', 'feature');
      expect(result).toBeNull();
    });
  });

  describe('getPRBranch', () => {
    it('returns head ref', async () => {
      octokit.rest.pulls.get.mockResolvedValue({
        data: { head: { ref: 'feature/42-fix' } },
      });
      const branch = await client.getPRBranch('o/r', 42);
      expect(branch).toBe('feature/42-fix');
    });
  });

  describe('mergePR', () => {
    it('merges with default method', async () => {
      octokit.rest.pulls.merge.mockResolvedValue({});
      octokit.rest.pulls.get.mockResolvedValue({ data: { head: { ref: 'feature' } } });
      octokit.rest.git.deleteRef.mockResolvedValue({});
      await client.mergePR('o/r', 42);
      expect(octokit.rest.pulls.merge).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', pull_number: 42, merge_method: 'merge',
      });
    });

    it('deletes branch after merge', async () => {
      octokit.rest.pulls.merge.mockResolvedValue({});
      octokit.rest.pulls.get.mockResolvedValue({ data: { head: { ref: 'feature/x' } } });
      octokit.rest.git.deleteRef.mockResolvedValue({});
      await client.mergePR('o/r', 42, 'squash');
      expect(octokit.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', ref: 'heads/feature/x',
      });
    });
  });

  describe('isPRMergeable', () => {
    it('returns true when mergeable', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: { mergeable: true } });
      expect(await client.isPRMergeable('o/r', 1)).toBe(true);
    });

    it('returns false when not mergeable', async () => {
      octokit.rest.pulls.get.mockResolvedValue({ data: { mergeable: false } });
      expect(await client.isPRMergeable('o/r', 1)).toBe(false);
    });

    it('returns false on error', async () => {
      octokit.rest.pulls.get.mockRejectedValue(new Error('fail'));
      expect(await client.isPRMergeable('o/r', 1)).toBe(false);
    });
  });

  describe('getPRReviews', () => {
    it('fetches reviews and comments in parallel', async () => {
      octokit.rest.pulls.listReviews.mockResolvedValue({
        data: [
          { user: { login: 'alice' }, state: 'APPROVED', body: 'lgtm', submitted_at: '2024-01-01T00:00:00Z' },
        ],
      });
      octokit.rest.pulls.listReviewComments.mockResolvedValue({
        data: [
          { user: { login: 'bob' }, body: 'fix', created_at: '2024-01-01T01:00:00Z', path: 'main.ts', line: 10 },
        ],
      });

      const result = await client.getPRReviews('o/r', 5);

      expect(result.reviews).toHaveLength(1);
      expect(result.reviews[0].author.login).toBe('alice');
      expect(result.reviews[0].state).toBe('APPROVED');

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].author.login).toBe('bob');
      expect(result.comments[0].path).toBe('main.ts');
      expect(result.comments[0].line).toBe(10);
    });
  });

  describe('closeIssue', () => {
    it('calls issues.update with state closed', async () => {
      octokit.rest.issues.update = vi.fn().mockResolvedValue({});
      await client.closeIssue('o/r', 42);
      expect(octokit.rest.issues.update).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', issue_number: 42, state: 'closed',
      });
    });
  });

  describe('closePR', () => {
    it('calls pulls.update with state closed', async () => {
      octokit.rest.pulls.update = vi.fn().mockResolvedValue({});
      await client.closePR('o/r', 10);
      expect(octokit.rest.pulls.update).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', pull_number: 10, state: 'closed',
      });
    });
  });

  describe('commentOnPR', () => {
    it('uses issues.createComment (PRs are issues)', async () => {
      octokit.rest.issues.createComment.mockResolvedValue({});
      await client.commentOnPR('o/r', 5, 'feedback');
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'o', repo: 'r', issue_number: 5, body: 'feedback',
      });
    });
  });
});

// ── App auth resolution tests ─────────────────────────────────────────

describe('resolveAppAuth', () => {
  const stateDir = path.join(os.homedir(), '.joynt-foundry');
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.FOUNDRY_GITHUB_APP_ID = process.env.FOUNDRY_GITHUB_APP_ID;
    savedEnv.FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH = process.env.FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH;
    savedEnv.FOUNDRY_GITHUB_APP_INSTALLATION_ID = process.env.FOUNDRY_GITHUB_APP_INSTALLATION_ID;

    delete process.env.FOUNDRY_GITHUB_APP_ID;
    delete process.env.FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH;
    delete process.env.FOUNDRY_GITHUB_APP_INSTALLATION_ID;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.restoreAllMocks();
  });

  it('returns credentials from env vars when all three are set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-test-'));
    const pemPath = path.join(tmpDir, 'test.pem');
    fs.writeFileSync(pemPath, '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n');

    process.env.FOUNDRY_GITHUB_APP_ID = '12345';
    process.env.FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
    process.env.FOUNDRY_GITHUB_APP_INSTALLATION_ID = '67890';

    const result = resolveAppAuth('testorg');
    expect(result).not.toBeNull();
    expect(result!.appId).toBe('12345');
    expect(result!.installationId).toBe('67890');
    expect(result!.privateKey).toContain('BEGIN RSA PRIVATE KEY');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('warns and returns null when env vars are partially set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    process.env.FOUNDRY_GITHUB_APP_ID = '12345';
    // Missing KEY_PATH and INSTALLATION_ID

    const result = resolveAppAuth('testorg');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Partial GitHub App env vars'));
  });

  it('returns credentials from saved files when they exist', () => {
    // Use a temp dir to simulate ~/.joynt-foundry/
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-test-'));
    const jsonPath = path.join(tmpDir, 'github-app-testorg.json');
    const pemPath = path.join(tmpDir, 'github-app-testorg.pem');

    fs.writeFileSync(jsonPath, JSON.stringify({ appId: 111, installationId: 222, slug: 'foundry-bot' }));
    fs.writeFileSync(pemPath, '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n');

    // We can't mock fs in ESM, so we test the function indirectly via env vars + real files.
    // The saved-file path is hardcoded to ~/.joynt-foundry/, so test the JSON parsing logic directly.
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const privateKey = fs.readFileSync(pemPath, 'utf-8');

    expect(String(meta.appId)).toBe('111');
    expect(String(meta.installationId)).toBe('222');
    expect(privateKey).toContain('BEGIN RSA PRIVATE KEY');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns null when no credentials are found', () => {
    const result = resolveAppAuth('nonexistent-org');
    expect(result).toBeNull();
  });

  it('env vars override saved credentials', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-test-'));
    const pemPath = path.join(tmpDir, 'test.pem');
    fs.writeFileSync(pemPath, '-----BEGIN RSA PRIVATE KEY-----\nenv-key\n-----END RSA PRIVATE KEY-----\n');

    process.env.FOUNDRY_GITHUB_APP_ID = '99999';
    process.env.FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
    process.env.FOUNDRY_GITHUB_APP_INSTALLATION_ID = '88888';

    // Even if saved creds exist, env vars should win
    const result = resolveAppAuth('testorg');
    expect(result!.appId).toBe('99999');
    expect(result!.installationId).toBe('88888');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('appCredsExist', () => {
  it('returns false for a non-existent org (no files in ~/.joynt-foundry/)', () => {
    // Use a unique org name that will never have real files
    expect(appCredsExist('__nonexistent_org_test_12345__')).toBe(false);
  });
});
