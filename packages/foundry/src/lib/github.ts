/**
 * GitHub CLI (gh) wrapper — all GitHub operations go through `gh`.
 */
import { execFileSync, execFile } from 'node:child_process';
import type { GitHubIssue, GitHubComment } from '../types.js';

function gh(args: string[], cwd?: string): string {
  return execFileSync('gh', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env },
  }).trim();
}

function ghJson<T>(args: string[], cwd?: string): T {
  const raw = gh([...args, '--json'], cwd);
  return JSON.parse(raw);
}

// ── Issues ──────────────────────────────────────────────────────────────

export function listIssuesByLabel(repo: string, label: string): GitHubIssue[] {
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

export function getIssue(repo: string, issue: number): GitHubIssue {
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

export function addLabel(repo: string, issue: number, label: string): void {
  gh(['issue', 'edit', String(issue), '--repo', repo, '--add-label', label]);
}

export function removeLabel(repo: string, issue: number, label: string): void {
  gh(['issue', 'edit', String(issue), '--repo', repo, '--remove-label', label]);
}

export function addComment(repo: string, issue: number, body: string): void {
  gh(['issue', 'comment', String(issue), '--repo', repo, '--body', body]);
}

export function getComments(repo: string, issue: number): GitHubComment[] {
  const raw = gh([
    'api', `repos/${repo}/issues/${issue}/comments`,
    '--paginate',
  ]);
  return JSON.parse(raw);
}

export function hasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some(l => l.name === label);
}

// ── Labels ──────────────────────────────────────────────────────────────

export function ensureLabel(repo: string, name: string, color: string, description: string): void {
  try {
    gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force']);
  } catch {
    // label may already exist — that's fine
  }
}

// ── Pull Requests ───────────────────────────────────────────────────────

export function createPR(repo: string, opts: {
  title: string;
  body: string;
  head: string;
  base: string;
}): string {
  const result = gh([
    'pr', 'create',
    '--repo', repo,
    '--title', opts.title,
    '--body', opts.body,
    '--head', opts.head,
    '--base', opts.base,
  ]);
  // gh pr create outputs the PR URL
  return result;
}

export function getPRStatus(repo: string, branch: string): { state: string; url: string } | null {
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

export function mergePR(repo: string, pr: string | number, method: 'merge' | 'rebase' | 'squash' = 'merge'): void {
  gh([
    'pr', 'merge', String(pr),
    '--repo', repo,
    `--${method}`,
    '--delete-branch',
  ]);
}

export function isPRMergeable(repo: string, pr: string | number): boolean {
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

export interface PRReview {
  author: { login: string };
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  body: string;
  submittedAt: string;
}

export interface PRReviewComment {
  author: { login: string };
  body: string;
  createdAt: string;
  path: string;
  line: number | null;
}

export function getPRReviews(repo: string, prNumber: number): { reviews: PRReview[]; comments: PRReviewComment[] } {
  const raw = gh([
    'pr', 'view', String(prNumber),
    '--repo', repo,
    '--json', 'reviews,reviewComments',
  ]);
  const data = JSON.parse(raw);
  return {
    reviews: (data.reviews ?? []).map((r: any) => ({
      author: r.author ?? { login: 'unknown' },
      state: r.state,
      body: r.body ?? '',
      submittedAt: r.submittedAt,
    })),
    comments: (data.reviewComments ?? []).map((c: any) => ({
      author: c.author ?? { login: 'unknown' },
      body: c.body ?? '',
      createdAt: c.createdAt,
      path: c.path ?? '',
      line: c.line ?? null,
    })),
  };
}

export function commentOnPR(repo: string, prNumber: number, body: string): void {
  gh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', body]);
}

export function extractPRNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}
