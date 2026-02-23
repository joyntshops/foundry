/**
 * OctokitClient — GitHubClient backed by @octokit/rest.
 *
 * Auth: uses GITHUB_TOKEN env var, falling back to `gh auth token`.
 * Uses dynamic import for @octokit/rest since it's ESM-only.
 */
import { execFileSync } from 'node:child_process';
import type { GitHubClient, PRReview, PRReviewComment, CreatePROpts } from './github-client.js';
import type { GitHubIssue, GitHubComment } from '../types.js';

function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {
    throw new Error('No GITHUB_TOKEN env var and `gh auth token` failed. Authenticate first.');
  }
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, repoName] = repo.split('/');
  return { owner, repo: repoName };
}

// Lazy-loaded Octokit instance
type OctokitLike = {
  rest: {
    issues: {
      listForRepo(p: any): Promise<any>;
      get(p: any): Promise<any>;
      update(p: any): Promise<any>;
      addLabels(p: any): Promise<any>;
      removeLabel(p: any): Promise<any>;
      createComment(p: any): Promise<any>;
      listComments(p: any): Promise<any>;
      listLabelsForRepo(p: any): Promise<any>;
      deleteLabel(p: any): Promise<any>;
      updateLabel(p: any): Promise<any>;
      createLabel(p: any): Promise<any>;
    };
    pulls: {
      create(p: any): Promise<any>;
      list(p: any): Promise<any>;
      get(p: any): Promise<any>;
      update(p: any): Promise<any>;
      merge(p: any): Promise<any>;
      listReviews(p: any): Promise<any>;
      listReviewComments(p: any): Promise<any>;
    };
    git: {
      deleteRef(p: any): Promise<any>;
    };
  };
};

async function createOctokit(): Promise<OctokitLike> {
  const { Octokit } = await import('@octokit/rest');
  return new Octokit({ auth: resolveToken() });
}

export class OctokitClient implements GitHubClient {
  private _octokit: OctokitLike | null;

  constructor(octokit?: OctokitLike) {
    this._octokit = octokit ?? null;
  }

  private async octokit(): Promise<OctokitLike> {
    if (!this._octokit) {
      this._octokit = await createOctokit();
    }
    return this._octokit;
  }

  // ── Issues ──────────────────────────────────────────────────────────────

  async listIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await ok.rest.issues.listForRepo({
      owner,
      repo: repoName,
      labels: label,
      state: 'open',
      per_page: 50,
    });
    // Filter out pull requests (GitHub API returns PRs mixed with issues)
    return data
      .filter((i: any) => !i.pull_request)
      .map((i: any) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        labels: (i.labels ?? []).map((l: any) => ({ name: typeof l === 'string' ? l : l.name ?? '' })),
        html_url: i.html_url,
        state: i.state ?? 'open',
      }));
  }

  async getIssue(repo: string, issue: number): Promise<GitHubIssue> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    const { data: i } = await ok.rest.issues.get({
      owner,
      repo: repoName,
      issue_number: issue,
    });
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: (i.labels ?? []).map((l: any) => ({ name: typeof l === 'string' ? l : l.name ?? '' })),
      html_url: i.html_url,
      state: i.state ?? 'open',
    };
  }

  async addLabel(repo: string, issue: number, label: string): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.issues.addLabels({
      owner,
      repo: repoName,
      issue_number: issue,
      labels: [label],
    });
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.issues.removeLabel({
      owner,
      repo: repoName,
      issue_number: issue,
      name: label,
    });
  }

  async addComment(repo: string, issue: number, body: string): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: issue,
      body,
    });
  }

  async getComments(repo: string, issue: number): Promise<GitHubComment[]> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await ok.rest.issues.listComments({
      owner,
      repo: repoName,
      issue_number: issue,
      per_page: 100,
    });
    return data.map((c: any) => ({
      id: c.id,
      body: c.body ?? '',
      user: c.user ? { login: c.user.login } : null,
      created_at: c.created_at,
    }));
  }

  async closeIssue(repo: string, issue: number): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.issues.update({ owner, repo: repoName, issue_number: issue, state: 'closed' });
  }

  // ── Labels ──────────────────────────────────────────────────────────────

  async listLabels(repo: string): Promise<string[]> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await ok.rest.issues.listLabelsForRepo({
      owner,
      repo: repoName,
      per_page: 100,
    });
    return data.map((l: any) => l.name);
  }

  async deleteLabel(repo: string, name: string): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.issues.deleteLabel({
      owner,
      repo: repoName,
      name,
    });
  }

  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    try {
      await ok.rest.issues.updateLabel({
        owner,
        repo: repoName,
        name,
        color,
        description,
      });
    } catch {
      // Label doesn't exist — create it
      try {
        await ok.rest.issues.createLabel({
          owner,
          repo: repoName,
          name,
          color,
          description,
        });
      } catch {
        // best effort
      }
    }
  }

  // ── Pull Requests ───────────────────────────────────────────────────────

  async createPR(repo: string, opts: CreatePROpts): Promise<string> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await ok.rest.pulls.create({
      owner,
      repo: repoName,
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
    });
    return data.html_url;
  }

  async closePR(repo: string, pr: string | number): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.pulls.update({ owner, repo: repoName, pull_number: Number(pr), state: 'closed' });
  }

  async getPRStatus(repo: string, branch: string): Promise<{ state: string; url: string } | null> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    try {
      const { data } = await ok.rest.pulls.list({
        owner,
        repo: repoName,
        head: `${owner}:${branch}`,
        state: 'all',
        per_page: 1,
      });
      if (data.length === 0) return null;
      return { state: data[0].state, url: data[0].html_url };
    } catch {
      return null;
    }
  }

  async getPRBranch(repo: string, pr: string | number): Promise<string> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    const { data } = await ok.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: Number(pr),
    });
    return data.head.ref;
  }

  async mergePR(repo: string, pr: string | number, method: 'merge' | 'rebase' | 'squash' = 'merge'): Promise<void> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.pulls.merge({
      owner,
      repo: repoName,
      pull_number: Number(pr),
      merge_method: method,
    });
    // Delete the branch after merge (matching gh CLI --delete-branch)
    try {
      const { data } = await ok.rest.pulls.get({
        owner,
        repo: repoName,
        pull_number: Number(pr),
      });
      await ok.rest.git.deleteRef({
        owner,
        repo: repoName,
        ref: `heads/${data.head.ref}`,
      });
    } catch {
      // best effort branch deletion
    }
  }

  async isPRMergeable(repo: string, pr: string | number): Promise<boolean> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);
    try {
      const { data } = await ok.rest.pulls.get({
        owner,
        repo: repoName,
        pull_number: Number(pr),
      });
      return data.mergeable === true;
    } catch {
      return false;
    }
  }

  // ── PR Reviews ─────────────────────────────────────────────────────────

  async getPRReviews(repo: string, prNumber: number): Promise<{ reviews: PRReview[]; comments: PRReviewComment[] }> {
    const ok = await this.octokit();
    const { owner, repo: repoName } = splitRepo(repo);

    // Fetch reviews and review comments in parallel
    const [reviewsResult, commentsResult] = await Promise.all([
      ok.rest.pulls.listReviews({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
      }),
      ok.rest.pulls.listReviewComments({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
      }),
    ]);

    return {
      reviews: reviewsResult.data.map((r: any) => ({
        author: { login: r.user?.login ?? 'unknown' },
        state: r.state,
        body: r.body ?? '',
        submittedAt: r.submitted_at ?? '',
      })),
      comments: commentsResult.data.map((c: any) => ({
        author: { login: c.user?.login ?? 'unknown' },
        body: c.body,
        createdAt: c.created_at,
        path: c.path,
        line: c.line ?? null,
      })),
    };
  }

  async commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
    const ok = await this.octokit();
    // PR comments use the issues API (PRs are issues in GitHub)
    const { owner, repo: repoName } = splitRepo(repo);
    await ok.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body,
    });
  }

  // ── Repository ─────────────────────────────────────────────────────────

  async getRepoSlug(): Promise<string> {
    return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
  }
}
