/**
 * MockGitHubClient — call-recording mock with configurable returns.
 * Used across all test suites.
 */
import type { GitHubClient, PRReview, PRReviewComment, CreatePROpts, CreateCheckRunOpts, UpdateCheckRunOpts } from '../github-client.js';
import type { GitHubIssue, GitHubComment } from '../../types.js';

export interface MockCall {
  method: string;
  args: any[];
}

export class MockGitHubClient implements GitHubClient {
  calls: MockCall[] = [];

  // Configurable return values
  issues: GitHubIssue[] = [];
  issue: GitHubIssue = { number: 1, title: 'Test', body: '', labels: [], html_url: 'https://github.com/o/r/issues/1', state: 'open' };
  comments: GitHubComment[] = [];
  labels: string[] = [];
  prUrl = 'https://github.com/o/r/pull/1';
  prStatus: { state: string; url: string } | null = { state: 'OPEN', url: 'https://github.com/o/r/pull/1' };
  prBranch = 'feature/1-test';
  prMergeable = true;
  prReviews: PRReview[] = [];
  prReviewComments: PRReviewComment[] = [];
  repoSlug = 'owner/repo';
  checkRunId = 12345;

  // Error injection
  errors: Map<string, Error> = new Map();

  private record(method: string, args: any[]): void {
    this.calls.push({ method, args });
    const err = this.errors.get(method);
    if (err) throw err;
  }

  reset(): void {
    this.calls = [];
    this.errors.clear();
  }

  getCalls(method: string): MockCall[] {
    return this.calls.filter(c => c.method === method);
  }

  async listIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]> {
    this.record('listIssuesByLabel', [repo, label]);
    return this.issues;
  }

  async getIssue(repo: string, issue: number): Promise<GitHubIssue> {
    this.record('getIssue', [repo, issue]);
    return this.issue;
  }

  async addLabel(repo: string, issue: number, label: string): Promise<void> {
    this.record('addLabel', [repo, issue, label]);
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    this.record('removeLabel', [repo, issue, label]);
  }

  async addComment(repo: string, issue: number, body: string): Promise<void> {
    this.record('addComment', [repo, issue, body]);
  }

  async getComments(repo: string, issue: number): Promise<GitHubComment[]> {
    this.record('getComments', [repo, issue]);
    return this.comments;
  }

  async closeIssue(repo: string, issue: number): Promise<void> {
    this.record('closeIssue', [repo, issue]);
  }

  async listLabels(repo: string): Promise<string[]> {
    this.record('listLabels', [repo]);
    return this.labels;
  }

  async deleteLabel(repo: string, name: string): Promise<void> {
    this.record('deleteLabel', [repo, name]);
  }

  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    this.record('ensureLabel', [repo, name, color, description]);
  }

  async createPR(repo: string, opts: CreatePROpts): Promise<string> {
    this.record('createPR', [repo, opts]);
    return this.prUrl;
  }

  async closePR(repo: string, pr: string | number): Promise<void> {
    this.record('closePR', [repo, pr]);
  }

  async getPRStatus(repo: string, branch: string): Promise<{ state: string; url: string } | null> {
    this.record('getPRStatus', [repo, branch]);
    return this.prStatus;
  }

  async getPRBranch(repo: string, pr: string | number): Promise<string> {
    this.record('getPRBranch', [repo, pr]);
    return this.prBranch;
  }

  async mergePR(repo: string, pr: string | number, method?: 'merge' | 'rebase' | 'squash'): Promise<void> {
    this.record('mergePR', [repo, pr, method]);
  }

  async isPRMergeable(repo: string, pr: string | number): Promise<boolean> {
    this.record('isPRMergeable', [repo, pr]);
    return this.prMergeable;
  }

  async getPRReviews(repo: string, prNumber: number): Promise<{ reviews: PRReview[]; comments: PRReviewComment[] }> {
    this.record('getPRReviews', [repo, prNumber]);
    return { reviews: this.prReviews, comments: this.prReviewComments };
  }

  async commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
    this.record('commentOnPR', [repo, prNumber, body]);
  }

  async updateComment(repo: string, commentId: number, body: string): Promise<void> {
    this.record('updateComment', [repo, commentId, body]);
  }

  async createReactionForIssueComment(repo: string, commentId: number, reaction: string): Promise<void> {
    this.record('createReactionForIssueComment', [repo, commentId, reaction]);
  }

  async createCheckRun(repo: string, opts: CreateCheckRunOpts): Promise<number> {
    this.record('createCheckRun', [repo, opts]);
    return this.checkRunId;
  }

  async updateCheckRun(repo: string, checkRunId: number, opts: UpdateCheckRunOpts): Promise<void> {
    this.record('updateCheckRun', [repo, checkRunId, opts]);
  }

  async getRepoSlug(): Promise<string> {
    this.record('getRepoSlug', []);
    return this.repoSlug;
  }
}
