/**
 * GitHub event mapping — converts a GitHub event payload (as delivered to a
 * GitHub Actions job in $GITHUB_EVENT_PATH) into FoundryEvent instances.
 */
import type { FoundryEvent } from './events.js';
import type { FoundryConfig, TaskState, GitHubIssue } from '../types.js';
import * as state from './state.js';

// ── Event mapping ───────────────────────────────────────────────────────

/**
 * Map a GitHub webhook event + payload into zero or more FoundryEvents.
 *
 * Returns an empty array when the event is irrelevant to Foundry.
 */
export function webhookToEvents(
  eventName: string,
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const action = payload.action as string | undefined;
  const fullEvent = action ? `${eventName}.${action}` : eventName;

  switch (fullEvent) {
    case 'issue_comment.created':
      return mapIssueComment(payload, config);
    case 'issues.labeled':
      return mapIssueLabeled(payload, config);
    case 'pull_request.closed':
      return mapPullRequestClosed(payload, config);
    case 'pull_request_review.submitted':
      return mapPullRequestReview(payload, config);
    default:
      return [];
  }
}

// ── issue_comment.created ───────────────────────────────────────────────

function mapIssueComment(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue) return [];

  const body: string = comment.body ?? '';
  const author: string = comment.user?.login ?? '';

  // Ignore bot comments
  if (author.includes('[bot]') || author === 'github-actions' || author === 'foundry') {
    return [];
  }

  const command = parseFoundryCommand(body, config);
  if (!command) return [];

  const issueNumber: number = issue.number;
  const repo = config.repo;

  // Look up existing task for this issue
  const task = state.getAllTasks(repo).find(t => t.issue === issueNumber);
  if (!task) return [];

  return [{
    type: 'command',
    task,
    command: command.name,
    message: command.message,
    commentId: comment.id,
    commentAuthor: author,
  }];
}

interface ParsedFoundryCommand {
  name: 'replan' | 'restart' | 'stop' | 'continue' | 'plan' | 'start';
  message?: string;
}

function parseFoundryCommand(body: string, config: FoundryConfig): ParsedFoundryCommand | null {
  const triggers = config.comment_triggers;
  const trimmed = body.trim();
  const firstLine = trimmed.split('\n')[0].trim();

  // Commands that accept trailing message
  if (trimmed.startsWith(triggers.continue)) {
    const msg = trimmed.slice(triggers.continue.length).trim();
    return { name: 'continue', message: msg || undefined };
  }
  if (trimmed.startsWith(triggers.start)) {
    const msg = trimmed.slice(triggers.start.length).trim();
    return { name: 'start', message: msg || undefined };
  }
  if (trimmed.startsWith(triggers.plan)) {
    const msg = trimmed.slice(triggers.plan.length).trim();
    return { name: 'plan', message: msg || undefined };
  }

  // Exact-match commands (first line only)
  if (firstLine === triggers.replan) return { name: 'replan' };
  if (firstLine === triggers.restart) return { name: 'restart' };
  if (firstLine === triggers.stop) return { name: 'stop' };

  return null;
}

// ── issues.labeled ──────────────────────────────────────────────────────

function mapIssueLabeled(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const label: string = payload.label?.name ?? '';
  const issue = payload.issue;
  if (!issue) return [];

  const ghIssue: GitHubIssue = {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    labels: (issue.labels ?? []).map((l: any) => ({ name: l.name })),
    html_url: issue.html_url,
    state: issue.state,
  };

  if (label === config.labels.ready) {
    return [{ type: 'issue_ready', issue: ghIssue }];
  }

  if (label === config.labels.claim) {
    return [{ type: 'issue_claim', issue: ghIssue }];
  }

  return [];
}

// ── pull_request.closed (merged) ────────────────────────────────────────

function mapPullRequestClosed(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const pr = payload.pull_request;
  if (!pr || !pr.merged) return [];

  const branch: string = pr.head?.ref ?? '';
  const repo = config.repo;

  // Find the task that owns this branch
  const task = state.getAllTasks(repo).find(t => t.branch === branch);
  if (!task) return [];

  return [{ type: 'pr_merged', task }];
}

// ── pull_request_review.submitted ───────────────────────────────────────

function mapPullRequestReview(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const review = payload.review;
  const pr = payload.pull_request;
  if (!review || !pr) return [];

  // Only act on "changes_requested" reviews
  if (review.state !== 'changes_requested') return [];

  const branch: string = pr.head?.ref ?? '';
  const repo = config.repo;

  const task = state.getAllTasks(repo).find(t => t.branch === branch);
  if (!task) return [];

  const feedback = buildReviewFeedback(review);

  return [{ type: 'pr_review', task, feedback }];
}

function buildReviewFeedback(review: Record<string, any>): string {
  const parts: string[] = ['PR review feedback for your changes:'];
  const author = review.user?.login ?? 'unknown';
  parts.push(`\n**Review by ${author} (changes requested):**`);
  if (review.body) parts.push(review.body);
  parts.push('\nPlease address the review feedback, commit your changes, and push.');
  return parts.join('\n');
}
