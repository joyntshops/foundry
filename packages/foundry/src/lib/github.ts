/**
 * GitHub module — thin facade over GitHubClient.
 *
 * Provides a module-level singleton and delegating functions so existing
 * call-sites (`github.addLabel(...)`) keep working. Tests inject a mock
 * via `setClient()`.
 */
import type { GitHubClient, CreatePROpts, PRReview, PRReviewComment } from './github-client.js';
import type { GitHubIssue, GitHubComment } from '../types.js';
import type { FoundryConfig } from '../types.js';
import { GhCliClient } from './gh-cli-client.js';

// Re-export types that consumers may need
export type { PRReview, PRReviewComment, CreatePROpts } from './github-client.js';
export type { GitHubClient } from './github-client.js';

// ── Singleton ────────────────────────────────────────────────────────────

let _client: GitHubClient = new GhCliClient();

export function setClient(client: GitHubClient): void {
  _client = client;
}

export function getClient(): GitHubClient {
  return _client;
}

/**
 * Initialize the GitHub client based on config and/or environment.
 *
 * Priority:
 *   1. FOUNDRY_GITHUB_BACKEND env var
 *   2. config.github_backend
 *   3. Auto-detect: if GitHub App credentials exist for the current org → octokit
 *   4. Default: gh-cli
 *
 * For the 'octokit' backend, auth is resolved from:
 *   1. GitHub App credentials (env vars or ~/.joynt-foundry/github-app-{org}.*)
 *   2. GITHUB_TOKEN env var
 *   3. `gh auth token` (falls back to gh CLI for token)
 */
export async function initClient(config?: FoundryConfig): Promise<void> {
  const envBackend = process.env.FOUNDRY_GITHUB_BACKEND;
  const org = config?.repo?.split('/')[0];

  let hasAppCreds = false;
  if (org) {
    const { appCredsExist } = await import('./octokit-client.js');
    hasAppCreds = appCredsExist(org);
  }

  const backend = envBackend ?? config?.github_backend ?? (hasAppCreds ? 'octokit' : 'gh-cli');

  if (backend === 'octokit' || hasAppCreds) {
    const { OctokitClient } = await import('./octokit-client.js');
    _client = new OctokitClient(undefined, org);
  } else {
    _client = new GhCliClient();
  }
}

// ── Delegate functions ───────────────────────────────────────────────────

export function listIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]> {
  return _client.listIssuesByLabel(repo, label);
}

export function getIssue(repo: string, issue: number): Promise<GitHubIssue> {
  return _client.getIssue(repo, issue);
}

export function addLabel(repo: string, issue: number, label: string): Promise<void> {
  return _client.addLabel(repo, issue, label);
}

export function removeLabel(repo: string, issue: number, label: string): Promise<void> {
  return _client.removeLabel(repo, issue, label);
}

export function addComment(repo: string, issue: number, body: string): Promise<void> {
  return _client.addComment(repo, issue, body);
}

export function getComments(repo: string, issue: number): Promise<GitHubComment[]> {
  return _client.getComments(repo, issue);
}

export function listLabels(repo: string): Promise<string[]> {
  return _client.listLabels(repo);
}

export function deleteLabel(repo: string, name: string): Promise<void> {
  return _client.deleteLabel(repo, name);
}

export function ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
  return _client.ensureLabel(repo, name, color, description);
}

export function closeIssue(repo: string, issue: number): Promise<void> {
  return _client.closeIssue(repo, issue);
}

export function closePR(repo: string, pr: string | number): Promise<void> {
  return _client.closePR(repo, pr);
}

export function createPR(repo: string, opts: CreatePROpts): Promise<string> {
  return _client.createPR(repo, opts);
}

export function getPRStatus(repo: string, branch: string): Promise<{ state: string; url: string } | null> {
  return _client.getPRStatus(repo, branch);
}

export function getPRBranch(repo: string, pr: string | number): Promise<string> {
  return _client.getPRBranch(repo, pr);
}

export function mergePR(repo: string, pr: string | number, method?: 'merge' | 'rebase' | 'squash'): Promise<void> {
  return _client.mergePR(repo, pr, method);
}

export function isPRMergeable(repo: string, pr: string | number): Promise<boolean> {
  return _client.isPRMergeable(repo, pr);
}

export function getPRReviews(repo: string, prNumber: number): Promise<{ reviews: PRReview[]; comments: PRReviewComment[] }> {
  return _client.getPRReviews(repo, prNumber);
}

export function commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
  return _client.commentOnPR(repo, prNumber, body);
}

export function updateComment(repo: string, commentId: number, body: string): Promise<void> {
  return _client.updateComment(repo, commentId, body);
}

export function getRepoSlug(): Promise<string> {
  return _client.getRepoSlug();
}

// ── Label transitions ────────────────────────────────────────────────────

/**
 * Transition labels on an issue: fetch current labels, remove only those
 * present, add only those missing. One `getIssue` call replaces N blind
 * DELETE requests that would 404 when a label isn't present.
 *
 * @param currentLabels - If the caller already has the label set (e.g. from
 *   a recently-fetched GitHubIssue), pass it to skip the extra API call.
 */
export async function transitionLabels(
  repo: string,
  issue: number,
  remove: string[],
  add: string[],
  currentLabels?: string[],
): Promise<void> {
  if (remove.length === 0 && add.length === 0) return;

  let labels = currentLabels;
  if (!labels) {
    const iss = await _client.getIssue(repo, issue);
    labels = iss.labels.map(l => l.name);
  }

  const present = new Set(labels);
  for (const label of remove) {
    if (present.has(label)) {
      try { await _client.removeLabel(repo, issue, label); } catch {}
    }
  }
  for (const label of add) {
    if (!present.has(label)) {
      await _client.addLabel(repo, issue, label);
    }
  }
}

// ── Pure logic (no interface needed) ─────────────────────────────────────

export function hasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some(l => l.name === label);
}

export function extractPRNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}
