/**
 * Task recovery — rebuild a TaskState from GitHub when local state is empty.
 *
 * `foundry action` runs in a fresh job for every event. The file-based state
 * store is therefore always empty at startup, but events like
 * `pull_request.closed` or an `@foundry` comment refer to a task that was
 * claimed by an earlier job. Everything needed to reconstruct that task is
 * already on GitHub: the structured claim comment, the issue's labels, the PR
 * for the branch, and the preview comment. This module reads them back.
 */
import * as github from './github.js';
import * as git from './git.js';
import { parseClaimComment } from './claim.js';
import type { FoundryConfig, TaskState, TaskStatus, GitHubIssue } from '../types.js';

const PREVIEW_MARKER = '<!-- foundry-preview -->';
const CLAIM_MARKER = '<!-- foundry-claim-block -->';

/**
 * Turn a branch template like `feature/{issue}-{slug}` into a matcher that
 * pulls the issue number back out of a branch name.
 */
export function issueNumberFromBranch(template: string, branch: string): number | null {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '^' + escaped
    .replace('\\{issue\\}', '(\\d+)')
    .replace('\\{slug\\}', '.*') + '$';
  const m = branch.match(new RegExp(pattern));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Find the issue a webhook payload is about. Issues and comments carry it
 * directly; pull requests carry it via the head branch name, with the PR
 * body's `Closes #N` as a fallback.
 */
export function issueNumberFromPayload(payload: Record<string, any>, config: FoundryConfig): number | null {
  if (typeof payload.issue?.number === 'number') return payload.issue.number;

  const pr = payload.pull_request;
  if (!pr) return null;

  const fromBranch = issueNumberFromBranch(config.branch_template, pr.head?.ref ?? '');
  if (fromBranch !== null) return fromBranch;

  const m = String(pr.body ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Map the issue's current state label to a TaskStatus. Null if untracked. */
export function statusFromLabels(config: FoundryConfig, labels: string[]): TaskStatus | null {
  const L = config.labels;
  const has = (l: string) => labels.includes(l);
  if (has(L.done)) return 'done';
  if (has(L.failed)) return 'failed';
  if (has(L.ready_for_review)) return 'pr-open';
  if (has(L.plan_review)) return 'plan-review';
  if (has(L.waiting_for_input)) return 'waiting-for-input';
  if (has(L.in_progress)) return 'agent-running';
  if (has(L.claim)) return 'claimed';
  return null;
}

function permissionModeFromLabels(config: FoundryConfig, labels: string[]): string {
  const modes = config.mode_labels ?? { plan: 'mode:plan', auto: 'mode:auto', default: 'mode:default' };
  if (labels.includes(modes.plan)) return '--permission-mode plan';
  if (labels.includes(modes.default)) return '--permission-mode default';
  return '--dangerously-skip-permissions';
}

function previewUrlFromComments(bodies: string[]): string | undefined {
  for (const body of bodies) {
    if (!body.includes(PREVIEW_MARKER)) continue;
    const m = body.match(/Preview URL:\s*(\S+)/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Rebuild the TaskState for an issue from GitHub. Returns null when the issue
 * has never been claimed by Foundry (no claim comment).
 */
export async function recoverTask(
  config: FoundryConfig,
  repoDir: string,
  issueNumber: number,
  issue?: GitHubIssue,
): Promise<TaskState | null> {
  const iss = issue ?? await github.getIssue(config.repo, issueNumber);
  const labels = iss.labels.map(l => l.name);

  const comments = await github.getComments(config.repo, issueNumber);
  const claimBodies = comments
    .filter(c => c.body.includes(CLAIM_MARKER))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const claim = claimBodies.length > 0 ? parseClaimComment(claimBodies[0].body) : null;
  if (!claim) return null;

  const branch = claim.branch || git.resolveBranchName(config.branch_template, issueNumber, iss.title);
  const status = statusFromLabels(config, labels) ?? 'claimed';

  let pr_url: string | undefined;
  let pr_number: number | undefined;
  try {
    const pr = await github.getPRStatus(config.repo, branch);
    if (pr?.url) {
      pr_url = pr.url;
      pr_number = github.extractPRNumber(pr.url) ?? undefined;
    }
  } catch {}

  let preview_url = previewUrlFromComments(comments.map(c => c.body));
  if (!preview_url && pr_number) {
    try {
      const prComments = await github.getComments(config.repo, pr_number);
      preview_url = previewUrlFromComments(prComments.map(c => c.body));
    } catch {}
  }

  const now = new Date().toISOString();
  return {
    issue: issueNumber,
    title: iss.title,
    repo: config.repo,
    branch,
    worktree: git.resolveWorktreePath(config.worktree_base, issueNumber, iss.title, repoDir),
    tmux_session: claim.tmux_session || git.workerId(issueNumber),
    agent_backend: claim.agent_backend || config.default_agent_backend,
    permission_mode: permissionModeFromLabels(config, labels),
    status,
    claimed_at: claimBodies[0].created_at,
    updated_at: now,
    runner_id: claim.runner_id,
    pr_url,
    pr_number,
    preview_url,
  };
}
