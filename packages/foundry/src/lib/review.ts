/**
 * Review and merge — what happens when a pull request is approved.
 *
 * The flow a careful maintainer follows by hand, done by the approve button:
 *
 *   1. Make sure the PR merges cleanly. GitHub computes that lazily, so wait.
 *   2. Rebase the branch onto its base so history stays linear, and push
 *      with --force-with-lease (the lease is the ref we just fetched).
 *   3. Wait for the PR's checks on the rebased head. A red check stops here.
 *   4. Merge with the rebase method.
 *   5. Run `integration_rebuild` on the merged base, when configured.
 *
 * Every step reports on the PR. Used by `foundry review` from a checkout and
 * by the pr_approved event under the Action; they must not diverge.
 */
import * as path from 'node:path';
import * as github from './github.js';
import * as git from './git.js';
import * as log from './log.js';
import * as verifyLib from './verify.js';
import { awaitMergeability } from './stale-prs.js';
import type { FoundryConfig } from '../types.js';

const REVIEW_MARKER = '<!-- foundry-review -->';
const CHECKS_POLL_MS = 15_000;
const DEFAULT_CHECKS_TIMEOUT_S = 900;

export interface ReviewTarget {
  pr_number: number;
  branch: string;
  base: string;
  /** Who approved, for the PR comment. */
  reviewer?: string;
}

export type ReviewOutcome =
  | { merged: true; sha: string; rebased: boolean; rebuild?: verifyLib.VerifyResult | null }
  | { merged: false; reason: 'conflicting' | 'rebase_failed' | 'checks_failed' | 'checks_timeout' | 'merge_failed'; detail: string };

export interface ChecksResult {
  state: 'success' | 'failure' | 'pending';
  failed: string[];
  pending: string[];
}

/** Summarise the check runs on a commit; our own run's job is ignored, it is never finished while we look. */
export function summariseChecks(runs: Array<{ name: string; status: string; conclusion: string | null }>, ignore: string[] = []): ChecksResult {
  const failed: string[] = [];
  const pending: string[] = [];
  for (const r of runs) {
    if (ignore.includes(r.name)) continue;
    if (r.status !== 'completed') { pending.push(r.name); continue; }
    if (r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion)) failed.push(r.name);
  }
  if (failed.length > 0) return { state: 'failure', failed, pending };
  if (pending.length > 0) return { state: 'pending', failed, pending };
  return { state: 'success', failed, pending };
}

/** Poll the checks on `sha` until none is pending, or the timeout passes. */
export async function awaitChecks(
  repo: string,
  sha: string,
  opts: { timeoutMs: number; pollMs?: number; ignore?: string[] },
): Promise<ChecksResult> {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const runs = await github.listCheckRuns(repo, sha);
    const result = summariseChecks(runs, opts.ignore ?? []);
    if (result.state !== 'pending' || Date.now() >= deadline) return result;
    // Never sleep past the deadline; a 1s timeout must not take a 15s poll to notice.
    await new Promise(r => setTimeout(r, Math.min(opts.pollMs ?? CHECKS_POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

async function postReviewComment(repo: string, pr: number, body: string): Promise<void> {
  const text = `${REVIEW_MARKER}\n${body}`;
  try {
    const comments = await github.getComments(repo, pr);
    const existing = comments.find(c => c.body.includes(REVIEW_MARKER));
    if (existing) await github.updateComment(repo, existing.id, text);
    else await github.commentOnPR(repo, pr, text);
  } catch (err: any) {
    log.warn(`Could not post review status on PR #${pr}: ${err.message}`);
  }
}

/** Rebase `branch` onto `origin/<base>` in a throwaway worktree and push. Returns the new head, or null when nothing changed. */
function rebaseAndPush(config: FoundryConfig, repoDir: string, branch: string, base: string, pr: number): { sha: string; changed: boolean } {
  const wt = path.resolve(repoDir, config.worktree_base, `review-${pr}`);
  git.fetchAll(repoDir);
  git.pruneWorktrees(repoDir);
  if (git.worktreeExists(wt, repoDir)) git.removeWorktree(wt, repoDir);
  git.addWorktreeTracking(wt, branch, repoDir);
  try {
    const before = git.headSha(wt);
    git.rebase(`origin/${base}`, wt);
    const after = git.headSha(wt);
    if (after !== before) git.push(branch, wt, true);
    return { sha: after, changed: after !== before };
  } finally {
    try { git.removeWorktree(wt, repoDir); } catch {}
  }
}

export async function reviewAndMerge(config: FoundryConfig, repoDir: string, target: ReviewTarget): Promise<ReviewOutcome> {
  const { pr_number: pr, branch, base } = target;
  const repo = config.repo;
  const who = target.reviewer ? ` by @${target.reviewer}` : '';
  const lines: string[] = [`**Foundry review**: approved${who}.`];

  // 1. Mergeable?
  const mergeability = await awaitMergeability(repo, pr);
  if (mergeability === 'conflicting') {
    lines.push(`- Not merged: this branch conflicts with \`${base}\`.`);
    await postReviewComment(repo, pr, lines.join('\n'));
    return { merged: false, reason: 'conflicting', detail: `conflicts with ${base}` };
  }

  // 2. Rebase for linear history.
  let sha: string;
  let rebased = false;
  try {
    const r = rebaseAndPush(config, repoDir, branch, base, pr);
    sha = r.sha; rebased = r.changed;
    lines.push(rebased ? `- Rebased onto \`${base}\` and pushed (${sha.slice(0, 7)}).` : `- Already up to date with \`${base}\` (${sha.slice(0, 7)}).`);
  } catch (err: any) {
    const detail = (err.stderr ?? err.message ?? String(err)).toString().slice(-800);
    lines.push(`- Not merged: rebase onto \`${base}\` failed.\n\`\`\`\n${detail}\n\`\`\``);
    await postReviewComment(repo, pr, lines.join('\n'));
    return { merged: false, reason: 'rebase_failed', detail };
  }
  await postReviewComment(repo, pr, [...lines, '- Waiting for checks…'].join('\n'));

  // 3. Checks on the (possibly new) head.
  const timeoutMs = (config.review?.checks_timeout_seconds ?? DEFAULT_CHECKS_TIMEOUT_S) * 1000;
  const checks = await awaitChecks(repo, sha, { timeoutMs, ignore: [process.env.GITHUB_JOB ?? ''] });
  if (checks.state === 'failure') {
    lines.push(`- Not merged: failing checks: ${checks.failed.map(n => `\`${n}\``).join(', ')}.`);
    await postReviewComment(repo, pr, lines.join('\n'));
    return { merged: false, reason: 'checks_failed', detail: checks.failed.join(', ') };
  }
  if (checks.state === 'pending') {
    lines.push(`- Not merged: checks still pending after ${timeoutMs / 1000}s: ${checks.pending.map(n => `\`${n}\``).join(', ')}. Approve again once they finish.`);
    await postReviewComment(repo, pr, lines.join('\n'));
    return { merged: false, reason: 'checks_timeout', detail: checks.pending.join(', ') };
  }
  lines.push('- Checks passed.');

  // 4. Merge. If the rebase changed the head, GitHub recomputes mergeability; wait for it.
  if (rebased) await awaitMergeability(repo, pr);
  try {
    await github.mergePR(repo, pr, 'rebase');
    lines.push(`- Merged into \`${base}\`.`);
  } catch (err: any) {
    const detail = (err.message ?? String(err)).slice(-500);
    lines.push(`- Not merged: GitHub refused the merge: ${detail}`);
    await postReviewComment(repo, pr, lines.join('\n'));
    return { merged: false, reason: 'merge_failed', detail };
  }

  // 5. Integration rebuild on the merged base.
  let rebuild: verifyLib.VerifyResult | null = null;
  if (config.integration_rebuild) {
    const wt = path.resolve(repoDir, config.worktree_base, `rebuild-${pr}`);
    try {
      git.fetchAll(repoDir);
      git.pruneWorktrees(repoDir);
      if (git.worktreeExists(wt, repoDir)) git.removeWorktree(wt, repoDir);
      git.addWorktreeTracking(wt, base, repoDir);
      rebuild = verifyLib.runIntegrationRebuild(config, wt);
      if (rebuild && !rebuild.success) {
        lines.push(`- **Integration rebuild FAILED** on \`${base}\` after the merge:\n\`\`\`\n${rebuild.output.slice(-800)}\n\`\`\``);
      } else {
        lines.push(`- Integration rebuild passed.`);
      }
    } catch (err: any) {
      lines.push(`- Integration rebuild could not run: ${err.message}`);
    } finally {
      try { git.removeWorktree(wt, repoDir); } catch {}
    }
  }

  await postReviewComment(repo, pr, lines.join('\n'));
  log.success(`PR #${pr} merged into ${base}${rebased ? ' after rebase' : ''}.`);
  return { merged: true, sha, rebased, rebuild };
}
