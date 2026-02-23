/**
 * Tests for the github.ts facade: pure logic helpers + delegation to client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { GhCliClient } from './gh-cli-client.js';

describe('pure logic helpers', () => {
  describe('hasLabel', () => {
    it('returns true when the label is present', () => {
      const issue = { number: 1, title: 'T', body: '', labels: [{ name: 'bug' }], html_url: '', state: 'open' };
      expect(github.hasLabel(issue, 'bug')).toBe(true);
    });

    it('returns false when the label is absent', () => {
      const issue = { number: 1, title: 'T', body: '', labels: [{ name: 'bug' }], html_url: '', state: 'open' };
      expect(github.hasLabel(issue, 'feature')).toBe(false);
    });

    it('returns false for empty labels', () => {
      const issue = { number: 1, title: 'T', body: '', labels: [], html_url: '', state: 'open' };
      expect(github.hasLabel(issue, 'bug')).toBe(false);
    });
  });

  describe('extractPRNumber', () => {
    it('extracts number from standard PR URL', () => {
      expect(github.extractPRNumber('https://github.com/owner/repo/pull/42')).toBe(42);
    });

    it('returns null for non-PR URL', () => {
      expect(github.extractPRNumber('https://github.com/owner/repo/issues/42')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(github.extractPRNumber('')).toBeNull();
    });

    it('extracts number from URL with trailing slash', () => {
      expect(github.extractPRNumber('https://github.com/owner/repo/pull/7/')).toBe(7);
    });
  });
});

describe('facade delegation', () => {
  let mock: MockGitHubClient;
  let originalClient: github.GitHubClient;

  beforeEach(() => {
    originalClient = github.getClient();
    mock = new MockGitHubClient();
    github.setClient(mock);
  });

  afterEach(() => {
    github.setClient(originalClient);
  });

  it('delegates addLabel to client', async () => {
    await github.addLabel('o/r', 1, 'bug');
    expect(mock.getCalls('addLabel')).toEqual([{ method: 'addLabel', args: ['o/r', 1, 'bug'] }]);
  });

  it('delegates removeLabel to client', async () => {
    await github.removeLabel('o/r', 1, 'bug');
    expect(mock.getCalls('removeLabel')).toEqual([{ method: 'removeLabel', args: ['o/r', 1, 'bug'] }]);
  });

  it('delegates listIssuesByLabel to client', async () => {
    mock.issues = [{ number: 5, title: 'T', body: '', labels: [], html_url: '', state: 'open' }];
    const result = await github.listIssuesByLabel('o/r', 'ready');
    expect(result).toEqual(mock.issues);
    expect(mock.getCalls('listIssuesByLabel')[0].args).toEqual(['o/r', 'ready']);
  });

  it('delegates createPR to client', async () => {
    mock.prUrl = 'https://github.com/o/r/pull/10';
    const url = await github.createPR('o/r', { title: 'T', body: 'B', head: 'h', base: 'b' });
    expect(url).toBe('https://github.com/o/r/pull/10');
  });

  it('delegates getPRReviews to client', async () => {
    mock.prReviews = [{ author: { login: 'bob' }, state: 'APPROVED', body: '', submittedAt: '' }];
    const { reviews } = await github.getPRReviews('o/r', 1);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].author.login).toBe('bob');
  });

  it('delegates getRepoSlug to client', async () => {
    mock.repoSlug = 'myorg/myrepo';
    const slug = await github.getRepoSlug();
    expect(slug).toBe('myorg/myrepo');
  });

  it('delegates closeIssue to client', async () => {
    await github.closeIssue('o/r', 42);
    expect(mock.getCalls('closeIssue')).toEqual([{ method: 'closeIssue', args: ['o/r', 42] }]);
  });

  it('delegates closePR to client', async () => {
    await github.closePR('o/r', 10);
    expect(mock.getCalls('closePR')).toEqual([{ method: 'closePR', args: ['o/r', 10] }]);
  });

  it('delegates isPRMergeable to client', async () => {
    mock.prMergeable = false;
    const result = await github.isPRMergeable('o/r', 5);
    expect(result).toBe(false);
  });

  it('delegates getPRBranch to client', async () => {
    mock.prBranch = 'feature/42-fix';
    const branch = await github.getPRBranch('o/r', 42);
    expect(branch).toBe('feature/42-fix');
  });
});

describe('initClient', () => {
  let originalClient: github.GitHubClient;
  const originalEnv = process.env.FOUNDRY_GITHUB_BACKEND;

  beforeEach(() => {
    originalClient = github.getClient();
  });

  afterEach(() => {
    github.setClient(originalClient);
    if (originalEnv === undefined) {
      delete process.env.FOUNDRY_GITHUB_BACKEND;
    } else {
      process.env.FOUNDRY_GITHUB_BACKEND = originalEnv;
    }
  });

  it('defaults to GhCliClient when no config or env', async () => {
    delete process.env.FOUNDRY_GITHUB_BACKEND;
    await github.initClient();
    expect(github.getClient()).toBeInstanceOf(GhCliClient);
  });

  it('uses GhCliClient when config says gh-cli', async () => {
    delete process.env.FOUNDRY_GITHUB_BACKEND;
    await github.initClient({ github_backend: 'gh-cli' } as any);
    expect(github.getClient()).toBeInstanceOf(GhCliClient);
  });

  it('uses OctokitClient when config says octokit', async () => {
    delete process.env.FOUNDRY_GITHUB_BACKEND;
    // Set GITHUB_TOKEN so OctokitClient doesn't try to shell out to gh
    const origToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      await github.initClient({ github_backend: 'octokit' } as any);
      const client = github.getClient();
      expect(client.constructor.name).toBe('OctokitClient');
    } finally {
      if (origToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = origToken;
    }
  });

  it('env var overrides config', async () => {
    process.env.FOUNDRY_GITHUB_BACKEND = 'gh-cli';
    // Even though config says octokit, env should win
    await github.initClient({ github_backend: 'octokit' } as any);
    expect(github.getClient()).toBeInstanceOf(GhCliClient);
  });
});
