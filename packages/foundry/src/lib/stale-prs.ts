/**
 * Stale pull requests — when `integration` moves, other open Foundry PRs may
 * no longer merge cleanly. Nobody should have to notice that by hand.
 *
 * After a PR merges, every other open PR into the same base that belongs to
 * a Foundry task is checked. GitHub computes mergeability lazily after the
 * base changes, so each check polls until the answer is known. For each PR
 * that now conflicts, Foundry dispatches its own workflow with a `continue`
 * command for the owning issue. `workflow_dispatch` is one of the two event
 * types GitHub still delivers when the job's own token causes them, and the
 * dispatched job runs under that issue's concurrency group like any other
 * command, so nothing here runs an agent outside its lane.
 */
import { execFileSync } from 'node:child_process';
import * as github from './github.js';
import * as log from './log.js';
import { issueNumberFromBranch } from './task-recovery.js';
import type { FoundryConfig } from '../types.js';

const MERGEABILITY_POLL_MS = 3_000;
const MERGEABILITY_TIMEOUT_MS = 90_000;

export interface StalePR {
  pr_number: number;
  branch: string;
  issue: number;
}

/** The instruction the agent receives. Rebase is allowed: relaunch pushes use --force-with-lease. */
export function conflictInstruction(base: string, mergedPR: number): string {
  return [
    `\`${base}\` has moved (PR #${mergedPR} merged) and this branch now conflicts with it.`,
    `Rebase onto \`origin/${base}\` (or merge it in if the history is messy), resolve every conflict in favour of this issue's intent while keeping what landed in \`${base}\`, make sure the result builds, and commit.`,
    'Do not change anything unrelated to the conflict.',
  ].join(' ');
}

/** Resolve mergeability, polling while GitHub still says "unknown". */
export async function awaitMergeability(
  repo: string,
  pr: number,
  timeoutMs: number = MERGEABILITY_TIMEOUT_MS,
  pollMs: number = MERGEABILITY_POLL_MS,
): Promise<'mergeable' | 'conflicting' | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const state = await github.getPRMergeability(repo, pr);
    if (state !== 'unknown' || Date.now() >= deadline) return state;
    await new Promise(r => setTimeout(r, pollMs));
  }
}

/**
 * Open Foundry PRs into `base` that no longer merge cleanly, excluding
 * `exceptPR` (the one that just merged).
 */
export async function findStalePRs(config: FoundryConfig, base: string, exceptPR?: number): Promise<StalePR[]> {
  const open = await github.listOpenPRs(config.repo, base);
  const stale: StalePR[] = [];
  for (const pr of open) {
    if (pr.number === exceptPR) continue;
    const issue = issueNumberFromBranch(config.branch_template, pr.head);
    if (issue === null) continue;
    const state = await awaitMergeability(config.repo, pr.number);
    if (state === 'conflicting') stale.push({ pr_number: pr.number, branch: pr.head, issue });
    else if (state === 'unknown') log.warn(`Mergeability of PR #${pr.number} still unknown; skipping.`);
  }
  return stale;
}

/** The workflow file this job is running from, e.g. `foundry.yml`. */
export function currentWorkflowFile(): string | null {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? '';
  const m = ref.match(/\.github\/workflows\/([^@]+)@/);
  return m ? m[1] : null;
}

/**
 * Start a Foundry job for `issue` with a command, through workflow_dispatch.
 * Needs `actions: write`. Returns false when dispatch is not possible.
 */
export function dispatchCommand(
  issue: number,
  command: string,
  message: string,
  opts: { workflowFile?: string | null; ref?: string } = {},
): boolean {
  const file = opts.workflowFile ?? currentWorkflowFile();
  if (!file) {
    log.warn('Cannot dispatch: GITHUB_WORKFLOW_REF is not set (not running in GitHub Actions?).');
    return false;
  }
  const args = ['workflow', 'run', file, '-f', `issue=${issue}`, '-f', `command=${command}`, '-f', `message=${message}`];
  if (opts.ref) args.push('--ref', opts.ref);
  try {
    execFileSync('gh', args, { encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (err: any) {
    log.warn(`Dispatch failed for #${issue}: ${(err.stderr ?? err.message ?? '').toString().trim()}`);
    return false;
  }
}

/**
 * After `mergedPR` landed in `base`: find conflicting Foundry PRs, tell each
 * issue, and dispatch the agent to resolve them. Never throws.
 */
export async function handleStalePRs(config: FoundryConfig, base: string, mergedPR?: number): Promise<StalePR[]> {
  let stale: StalePR[] = [];
  try {
    stale = await findStalePRs(config, base, mergedPR);
  } catch (err: any) {
    log.warn(`Stale PR check failed: ${err.message}`);
    return [];
  }
  if (stale.length === 0) {
    log.info(`No open Foundry PRs into ${base} conflict after the merge.`);
    return [];
  }

  for (const s of stale) {
    log.info(`PR #${s.pr_number} (#${s.issue}) conflicts with ${base}; sending the agent to resolve it.`);
    const instruction = conflictInstruction(base, mergedPR ?? 0);
    const dispatched = dispatchCommand(s.issue, 'continue', instruction);
    const note = dispatched
      ? `**${base} moved** (PR #${mergedPR ?? '?'} merged) and PR #${s.pr_number} now conflicts with it. Foundry has sent the agent to rebase and resolve.`
      : `**${base} moved** (PR #${mergedPR ?? '?'} merged) and PR #${s.pr_number} now conflicts with it. Foundry could not start the agent automatically; reply here with \`@foundry continue\` and the instruction below.\n\n> ${instruction}`;
    try { await github.addComment(config.repo, s.issue, note); } catch (err: any) {
      log.warn(`Could not note the conflict on #${s.issue}: ${err.message}`);
    }
  }
  return stale;
}
