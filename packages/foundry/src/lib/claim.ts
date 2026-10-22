/**
 * Issue claim protocol — safe, idempotent, verifiable.
 */
import * as github from './github.js';
import * as state from './state.js';
import { setStateLabel } from './labels.js';
import type { FoundryConfig, GitHubIssue, TaskState } from '../types.js';

export interface ClaimInfo {
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
    `| Worker | \`${info.tmux_session}\` |`,
    `| Agent Backend | \`${info.agent_backend}\` |`,
    `| Claimed At | ${new Date().toISOString()} |`,
    '',
    '<details><summary><b>Commands</b></summary>',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `@foundry go [message]` | Continue from the branch: answer a question, approve a plan, resume after a failure |',
    '| `@foundry restart` | Discard the branch and start over |',
    '| `@foundry stop` | Stop the agent; the branch stays |',
    '',
    'Every comment on this issue is given to the agent on its next launch; only these three start or stop it. The message can be on the same line or start on the next line.',
    '',
    '</details>',
    '<!-- /foundry-claim-block -->',
  ].join('\n');
}

export function parseClaimComment(body: string): ClaimInfo | null {
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
    tmux_session: extract('Worker') || extract('tmux Session'),
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

  // Step 1: Make in-progress the sole state label
  const currentLabels = issue.labels.map(l => l.name);
  await setStateLabel(config, issue.number, 'in_progress', currentLabels);

  // Step 2: Post claim comment
  await github.addComment(config.repo, issue.number, buildClaimComment(claimInfo));

  // Step 3: Verify — re-fetch issue and check our claim is the active one
  await sleep(1000); // brief delay to avoid race

  const comments = await github.getComments(config.repo, issue.number);
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
 * Mark an issue as failed on GitHub: `failed` becomes the sole state label.
 */
export async function markFailed(config: FoundryConfig, issue: number): Promise<void> {
  await setStateLabel(config, issue, 'failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
