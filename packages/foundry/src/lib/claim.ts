/**
 * Issue claim protocol — safe, idempotent, verifiable.
 */
import * as github from './github.js';
import * as state from './state.js';
import type { FoundryConfig, GitHubIssue, TaskState } from '../types.js';

interface ClaimInfo {
  runner_id: string;
  branch: string;
  worktree: string;
  tmux_session: string;
  agent_backend: string;
}

function buildClaimComment(info: ClaimInfo): string {
  return [
    '<!-- foundry-claim-block -->',
    '**Foundry Claim**',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Runner | \`${info.runner_id}\` |`,
    `| Branch | \`${info.branch}\` |`,
    `| Worktree | \`${info.worktree}\` |`,
    `| tmux Session | \`${info.tmux_session}\` |`,
    `| Agent Backend | \`${info.agent_backend}\` |`,
    `| Claimed At | ${new Date().toISOString()} |`,
    '<!-- /foundry-claim-block -->',
  ].join('\n');
}

function parseClaimComment(body: string): ClaimInfo | null {
  if (!body.includes('<!-- foundry-claim-block -->')) return null;
  const extract = (field: string): string => {
    const re = new RegExp('\\| ' + field + ' \\| `([^`]+)` \\|');
    const m = body.match(re);
    return m?.[1] ?? '';
  };
  return {
    runner_id: extract('Runner'),
    branch: extract('Branch'),
    worktree: extract('Worktree'),
    tmux_session: extract('tmux Session'),
    agent_backend: extract('Agent Backend'),
  };
}

/**
 * Attempt to claim an issue. Returns true if this runner owns it.
 */
export async function claimIssue(
  config: FoundryConfig,
  issue: GitHubIssue,
  claimInfo: ClaimInfo,
): Promise<boolean> {
  const runnerId = state.getRunnerId();

  // Step 1: Swap labels
  try {
    github.removeLabel(config.repo, issue.number, config.labels.ready);
  } catch {
    // may already be removed
  }
  try { github.removeLabel(config.repo, issue.number, config.labels.failed); } catch {}
  github.addLabel(config.repo, issue.number, config.labels.in_progress);

  // Step 2: Post claim comment
  github.addComment(config.repo, issue.number, buildClaimComment(claimInfo));

  // Step 3: Verify — re-fetch issue and check our claim is the active one
  await sleep(1000); // brief delay to avoid race

  const comments = github.getComments(config.repo, issue.number);
  const claimComments = comments
    .filter(c => c.body.includes('<!-- foundry-claim-block -->'))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (claimComments.length === 0) return false;

  const latestClaim = parseClaimComment(claimComments[0].body);
  if (!latestClaim) return false;

  return latestClaim.runner_id === runnerId;
}

/**
 * Check if issue is already claimed by this runner.
 */
export function isClaimedByUs(config: FoundryConfig, issue: number): boolean {
  const tasks = state.getAllTasks(config.repo);
  return tasks.some(t => t.issue === issue && !['done', 'failed', 'stopped'].includes(t.status));
}

/**
 * Mark an issue as failed on GitHub.
 * Removes in_progress/waiting_for_input, adds the failed label.
 */
export function markFailed(config: FoundryConfig, issue: number): void {
  try { github.removeLabel(config.repo, issue, config.labels.in_progress); } catch {}
  try { github.removeLabel(config.repo, issue, config.labels.waiting_for_input); } catch {}
  try { github.addLabel(config.repo, issue, config.labels.failed); } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
