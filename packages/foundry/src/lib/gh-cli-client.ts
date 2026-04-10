/**
 * GhCliClient — GitHubClient backed by the `gh` CLI.
 *
 * Extracted from the original github.ts. All `gh` calls go through this class.
 */
import { execFileSync } from 'node:child_process';
import type { GitHubClient, PRReview, PRReviewComment, CreatePROpts, CreateCheckRunOpts, UpdateCheckRunOpts } from './github-client.js';
import type { GitHubIssue, GitHubComment } from '../types.js';

function gh(args: string[], cwd?: string): string {
  return execFileSync('gh', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env },
  }).trim();
}

export class GhCliClient implements GitHubClient {

  // ── Issues ──────────────────────────────────────────────────────────────

  async listIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]> {
    const raw = gh([
      'issue', 'list',
      '--repo', repo,
      '--label', label,
      '--state', 'open',
      '--json', 'number,title,body,labels,url,state',
      '--limit', '50',
    ]);
    const issues = JSON.parse(raw) as any[];
    return issues.map(i => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: (i.labels ?? []).map((l: any) => ({ name: l.name })),
      html_url: i.url,
      state: i.state,
    }));
  }

  async getIssue(repo: string, issue: number): Promise<GitHubIssue> {
    const raw = gh([
      'issue', 'view', String(issue),
      '--repo', repo,
      '--json', 'number,title,body,labels,url,state',
    ]);
    const i = JSON.parse(raw);
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: (i.labels ?? []).map((l: any) => ({ name: l.name })),
      html_url: i.url,
      state: i.state,
    };
  }

  async addLabel(repo: string, issue: number, label: string): Promise<void> {
    gh(['issue', 'edit', String(issue), '--repo', repo, '--add-label', label]);
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    gh(['issue', 'edit', String(issue), '--repo', repo, '--remove-label', label]);
  }

  async addComment(repo: string, issue: number, body: string): Promise<void> {
    gh(['issue', 'comment', String(issue), '--repo', repo, '--body', body]);
  }

  async getComments(repo: string, issue: number): Promise<GitHubComment[]> {
    const raw = gh([
      'api', `repos/${repo}/issues/${issue}/comments`,
      '--paginate',
    ]);
    return JSON.parse(raw);
  }

  async closeIssue(repo: string, issue: number): Promise<void> {
    gh(['issue', 'close', String(issue), '--repo', repo]);
  }

  // ── Labels ──────────────────────────────────────────────────────────────

  async listLabels(repo: string): Promise<string[]> {
    const raw = gh([
      'label', 'list',
      '--repo', repo,
      '--json', 'name',
      '--limit', '100',
    ]);
    const labels = JSON.parse(raw) as Array<{ name: string }>;
    return labels.map(l => l.name);
  }

  async deleteLabel(repo: string, name: string): Promise<void> {
    gh(['label', 'delete', name, '--repo', repo, '--yes']);
  }

  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    try {
      gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force']);
    } catch {
      // label may already exist — that's fine
    }
  }

  // ── Pull Requests ───────────────────────────────────────────────────────

  async createPR(repo: string, opts: CreatePROpts): Promise<string> {
    return gh([
      'pr', 'create',
      '--repo', repo,
      '--title', opts.title,
      '--body', opts.body,
      '--head', opts.head,
      '--base', opts.base,
    ]);
  }

  async closePR(repo: string, pr: string | number): Promise<void> {
    gh(['pr', 'close', String(pr), '--repo', repo]);
  }

  async getPRStatus(repo: string, branch: string): Promise<{ state: string; url: string } | null> {
    try {
      const raw = gh([
        'pr', 'view', branch,
        '--repo', repo,
        '--json', 'state,url',
      ]);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getPRBranch(repo: string, pr: string | number): Promise<string> {
    const raw = gh([
      'pr', 'view', String(pr),
      '--repo', repo,
      '--json', 'headRefName',
    ]);
    const data = JSON.parse(raw);
    return data.headRefName;
  }

  async mergePR(repo: string, pr: string | number, method: 'merge' | 'rebase' | 'squash' = 'merge'): Promise<void> {
    gh([
      'pr', 'merge', String(pr),
      '--repo', repo,
      `--${method}`,
      '--delete-branch',
    ]);
  }

  async isPRMergeable(repo: string, pr: string | number): Promise<boolean> {
    try {
      const raw = gh([
        'pr', 'view', String(pr),
        '--repo', repo,
        '--json', 'mergeable,mergeStateStatus',
      ]);
      const data = JSON.parse(raw);
      return data.mergeable === 'MERGEABLE';
    } catch {
      return false;
    }
  }

  // ── PR Reviews ─────────────────────────────────────────────────────────

  async getPRReviews(repo: string, prNumber: number): Promise<{ reviews: PRReview[]; comments: PRReviewComment[] }> {
    // `gh pr view --json reviews` returns reviews but `reviewComments` is
    // not a valid field.  Fetch review comments via the REST API instead.
    const reviewsRaw = gh([
      'pr', 'view', String(prNumber),
      '--repo', repo,
      '--json', 'reviews',
    ]);
    const reviewsData = JSON.parse(reviewsRaw);

    // Inline review comments via REST (same pattern as getComments)
    const [owner, repoName] = repo.split('/');
    const commentsRaw = gh([
      'api', `repos/${owner}/${repoName}/pulls/${prNumber}/comments`,
      '--paginate',
    ]);
    const rawComments = JSON.parse(commentsRaw);

    return {
      reviews: (reviewsData.reviews ?? []).map((r: any) => ({
        author: r.author ?? { login: 'unknown' },
        state: r.state,
        body: r.body ?? '',
        submittedAt: r.submittedAt,
      })),
      comments: (rawComments ?? []).map((c: any) => ({
        author: { login: c.user?.login ?? 'unknown' },
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
        path: c.path ?? '',
        line: c.line ?? null,
      })),
    };
  }

  async commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
    gh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', body]);
  }

  async updateComment(repo: string, commentId: number, body: string): Promise<void> {
    gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '-f', `body=${body}`]);
  }

  async createReactionForIssueComment(repo: string, commentId: number, reaction: string): Promise<void> {
    gh(['api', '--method', 'POST', `repos/${repo}/issues/comments/${commentId}/reactions`, '-f', `content=${reaction}`]);
  }

  // ── Check Runs ─────────────────────────────────────────────────────────

  async createCheckRun(repo: string, opts: CreateCheckRunOpts): Promise<number> {
    const args: string[] = [
      'api', '--method', 'POST', `repos/${repo}/check-runs`,
      '-f', `name=${opts.name}`,
      '-f', `head_sha=${opts.head_sha}`,
    ];
    if (opts.status) args.push('-f', `status=${opts.status}`);
    if (opts.conclusion) args.push('-f', `conclusion=${opts.conclusion}`);
    if (opts.output) {
      args.push('-f', `output[title]=${opts.output.title}`);
      args.push('-f', `output[summary]=${opts.output.summary}`);
    }
    const raw = gh(args);
    const data = JSON.parse(raw);
    return data.id;
  }

  async updateCheckRun(repo: string, checkRunId: number, opts: UpdateCheckRunOpts): Promise<void> {
    const args: string[] = [
      'api', '--method', 'PATCH', `repos/${repo}/check-runs/${checkRunId}`,
    ];
    if (opts.status) args.push('-f', `status=${opts.status}`);
    if (opts.conclusion) args.push('-f', `conclusion=${opts.conclusion}`);
    if (opts.output) {
      args.push('-f', `output[title]=${opts.output.title}`);
      args.push('-f', `output[summary]=${opts.output.summary}`);
    }
    gh(args);
  }

  // ── Repository ─────────────────────────────────────────────────────────

  async getRepoSlug(): Promise<string> {
    return gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  }
}
