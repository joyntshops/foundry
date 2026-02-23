/**
 * GitHubClient interface — all GitHub operations go through this contract.
 */
import type { GitHubIssue, GitHubComment } from '../types.js';

// ── Shared types ─────────────────────────────────────────────────────────

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

export interface CreatePROpts {
  title: string;
  body: string;
  head: string;
  base: string;
}

// ── GitHubClient interface ───────────────────────────────────────────────

export interface GitHubClient {
  // Issues
  listIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]>;
  getIssue(repo: string, issue: number): Promise<GitHubIssue>;
  addLabel(repo: string, issue: number, label: string): Promise<void>;
  removeLabel(repo: string, issue: number, label: string): Promise<void>;
  addComment(repo: string, issue: number, body: string): Promise<void>;
  getComments(repo: string, issue: number): Promise<GitHubComment[]>;

  // Labels
  listLabels(repo: string): Promise<string[]>;
  deleteLabel(repo: string, name: string): Promise<void>;
  ensureLabel(repo: string, name: string, color: string, description: string): Promise<void>;

  // Issues (lifecycle)
  closeIssue(repo: string, issue: number): Promise<void>;

  // Pull Requests
  createPR(repo: string, opts: CreatePROpts): Promise<string>;
  closePR(repo: string, pr: string | number): Promise<void>;
  getPRStatus(repo: string, branch: string): Promise<{ state: string; url: string } | null>;
  getPRBranch(repo: string, pr: string | number): Promise<string>;
  mergePR(repo: string, pr: string | number, method?: 'merge' | 'rebase' | 'squash'): Promise<void>;
  isPRMergeable(repo: string, pr: string | number): Promise<boolean>;

  // PR Reviews
  getPRReviews(repo: string, prNumber: number): Promise<{ reviews: PRReview[]; comments: PRReviewComment[] }>;
  commentOnPR(repo: string, prNumber: number, body: string): Promise<void>;

  // Repository
  getRepoSlug(): Promise<string>;
}
