/**
 * GitHub event mapping — converts a GitHub event payload (as delivered to a
 * GitHub Actions job in $GITHUB_EVENT_PATH) into FoundryEvent instances.
 *
 * What starts work is deliberately small:
 *   - an `@foundry go|restart|stop` comment on an issue (not on a PR),
 *   - a review requesting changes or approving,
 *   - a merge,
 *   - a `workflow_dispatch` carrying one of the three commands.
 * Labels never start anything and plain comments never start anything.
 */
import type { FoundryEvent, FoundryCommand } from './events.js';
import type { FoundryConfig } from '../types.js';
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
    case 'pull_request.opened':
    case 'pull_request.reopened':
    case 'pull_request.synchronize':
      return mapPullRequestPreview(payload, config, 'up');
    case 'pull_request.closed':
      return mapPullRequestClosed(payload, config);
    case 'pull_request_review.submitted':
      return mapPullRequestReview(payload, config);
    case 'workflow_dispatch':
      return mapWorkflowDispatch(payload, config);
    default:
      return [];
  }
}

// ── Commands ────────────────────────────────────────────────────────────

export interface ParsedFoundryCommand {
  name: FoundryCommand;
  message?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recognise a command at the very start of a comment. `go` takes a message
 * (same line or following lines); `restart` and `stop` are the first line on
 * their own. A mention anywhere else in a comment is just text.
 */
export function parseFoundryCommand(body: string, config: FoundryConfig): ParsedFoundryCommand | null {
  const t = config.comment_triggers;
  const trimmed = body.trim();
  const firstLine = trimmed.split('\n')[0].trim();

  if (new RegExp('^' + escapeRegExp(t.go) + '(?=\\s|$)').test(trimmed)) {
    const msg = trimmed.slice(t.go.length).trim();
    return { name: 'go', message: msg || undefined };
  }
  if (firstLine === t.restart) return { name: 'restart' };
  if (firstLine === t.stop) return { name: 'stop' };
  return null;
}

/**
 * The part of a comment that is not the command: the message after `go`, or
 * whatever followed a `restart`/`stop` line. Null when the comment is not a
 * command at all. Used to keep command comments in the agent's thread
 * without the command text itself.
 */
export function commandRemainder(body: string, config: FoundryConfig): string | null {
  const cmd = parseFoundryCommand(body, config);
  if (!cmd) return null;
  if (cmd.name === 'go') return cmd.message ?? '';
  const lines = body.trim().split('\n');
  return lines.slice(1).join('\n').trim();
}

/** Comments by GitHub Apps, Actions, and Foundry itself are never commands or context. */
export function isBotLogin(login: string): boolean {
  return login.includes('[bot]') || login === 'github-actions' || login === 'foundry';
}

// ── issue_comment.created ───────────────────────────────────────────────

function mapIssueComment(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue) return [];

  // A comment on a pull request arrives as an issue_comment whose number is
  // the PR's. It is not resolved to its issue yet, and must never be mistaken
  // for the issue with the same number.
  if (issue.pull_request) return [];

  const author: string = comment.user?.login ?? '';
  if (isBotLogin(author)) return [];

  const command = parseFoundryCommand(comment.body ?? '', config);
  if (!command) return [];

  const issueNumber: number = issue.number;
  const task = state.getAllTasks(config.repo).find(t => t.issue === issueNumber) ?? null;

  return [{
    type: 'command',
    issue: issueNumber,
    task,
    command: command.name,
    message: command.message,
    commentId: comment.id,
    commentAuthor: author,
    via: 'comment',
  }];
}

// ── workflow_dispatch ───────────────────────────────────────────────────

/**
 * A command delivered by `gh workflow run` with inputs {issue, command,
 * message}. This is how Foundry hands work to itself across jobs, since
 * workflow_dispatch is delivered even when the job's own token caused it.
 */
function mapWorkflowDispatch(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const inputs = payload.inputs ?? {};
  const issueNumber = parseInt(String(inputs.issue ?? ''), 10);
  if (!Number.isFinite(issueNumber)) return [];

  const name = String(inputs.command ?? '') as FoundryCommand;
  if (!(name in config.comment_triggers)) return [];
  const trigger = config.comment_triggers[name];
  const body = inputs.message ? `${trigger}\n${inputs.message}` : trigger;
  const command = parseFoundryCommand(body, config);
  if (!command) return [];

  const task = state.getAllTasks(config.repo).find(t => t.issue === issueNumber) ?? null;

  return [{
    type: 'command',
    issue: issueNumber,
    task,
    command: command.name,
    message: command.message,
    commentId: 0,
    commentAuthor: payload.sender?.login ?? 'workflow_dispatch',
    via: 'dispatch',
  }];
}

// ── pull_request.closed (merged) ────────────────────────────────────────

function mapPullRequestClosed(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const pr = payload.pull_request;
  if (!pr) return [];

  const branch: string = pr.head?.ref ?? '';
  const repo = config.repo;

  // A task's PR: completion on merge; a close without merge is a human
  // decision Foundry leaves alone.
  const task = state.getAllTasks(repo).find(t => t.branch === branch);
  if (task) return pr.merged ? [{ type: 'pr_merged', task, base: pr.base?.ref }] : [];

  // Any other PR with a listed base: its preview comes down, merged or not.
  return mapPullRequestPreview(payload, config, 'down');
}

/**
 * A pull request that is not a task but whose base is listed in
 * `preview.pull_request_bases` gets a preview of its own.
 */
function mapPullRequestPreview(
  payload: Record<string, any>,
  config: FoundryConfig,
  action: 'up' | 'down',
): FoundryEvent[] {
  const pr = payload.pull_request;
  if (!pr) return [];
  const bases = config.preview?.pull_request_bases ?? [];
  const base: string = pr.base?.ref ?? '';
  if (!bases.includes(base)) return [];

  const branch: string = pr.head?.ref ?? '';
  // A task's own PR is previewed through the task lifecycle, never twice.
  if (state.getAllTasks(config.repo).some(t => t.branch === branch)) return [];

  return [{
    type: 'pr_preview',
    action,
    pr_number: pr.number,
    branch,
    base,
    sha: pr.head?.sha ?? '',
  }];
}

// ── pull_request_review.submitted ───────────────────────────────────────

function mapPullRequestReview(
  payload: Record<string, any>,
  config: FoundryConfig,
): FoundryEvent[] {
  const review = payload.review;
  const pr = payload.pull_request;
  if (!review || !pr) return [];

  const branch: string = pr.head?.ref ?? '';
  const base: string = pr.base?.ref ?? '';
  const repo = config.repo;
  const task = state.getAllTasks(repo).find(t => t.branch === branch);

  if (review.state === 'changes_requested') {
    if (!task) return [];
    return [{ type: 'pr_review', task, feedback: buildReviewFeedback(review) }];
  }

  if (review.state === 'approved' && config.review?.merge_on_approval !== false) {
    const promotion = (config.preview?.pull_request_bases ?? []).includes(base);
    if (!task && !promotion) return [];
    return [{
      type: 'pr_approved',
      pr_number: pr.number,
      branch,
      base,
      reviewer: review.user?.login ?? 'unknown',
      ...(task ? { task } : {}),
    }];
  }

  return [];
}

function buildReviewFeedback(review: Record<string, any>): string {
  const parts: string[] = ['PR review feedback for your changes:'];
  const author = review.user?.login ?? 'unknown';
  parts.push(`\n**Review by ${author} (changes requested):**`);
  if (review.body) parts.push(review.body);
  parts.push('\nPlease address the review feedback, commit your changes, and push.');
  return parts.join('\n');
}
