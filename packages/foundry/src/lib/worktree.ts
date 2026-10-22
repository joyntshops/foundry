/**
 * Worktree lifecycle across jobs.
 *
 * A task's worktree lives only as long as the job that created it. When a job
 * ends with the agent waiting on a human, the branch is pushed so nothing is
 * lost; when a later job resumes the task, the worktree is recreated from the
 * pushed branch. Both functions are idempotent and safe to call when there is
 * nothing to do.
 */
import * as fs from 'node:fs';
import * as git from './git.js';
import * as log from './log.js';
import { resolveBaseBranch } from './branches.js';
import type { FoundryConfig, TaskState } from '../types.js';

export interface PreserveResult {
  /** A commit was made for uncommitted changes. */
  committed: boolean;
  /** The branch was pushed (it had commits beyond its base). */
  pushed: boolean;
}

/**
 * Make the agent's work survive the end of this job: commit anything
 * uncommitted, then push the branch if it has commits beyond its base.
 * Never throws; a failure is logged and reported in the result so the
 * status comment can say so.
 */
export function preserveWork(config: FoundryConfig, task: TaskState, repoDir: string, reason: string): PreserveResult {
  const result: PreserveResult = { committed: false, pushed: false };
  const wt = task.worktree;
  if (!fs.existsSync(wt)) return result;

  try {
    if (git.isDirty(wt)) {
      git.commitAll(`chore(foundry): work in progress (${reason})`, wt);
      result.committed = true;
      log.info(`#${task.issue}: committed work in progress before pausing.`);
    }
  } catch (err: any) {
    log.warn(`#${task.issue}: could not commit work in progress: ${err.message}`);
  }

  try {
    const base = resolveBaseBranch(config, repoDir);
    if (git.countCommits(`${base}..HEAD`, wt) > 0) {
      git.push(task.branch, wt, true);
      result.pushed = true;
      log.info(`#${task.issue}: pushed ${task.branch}.`);
    }
  } catch (err: any) {
    log.warn(`#${task.issue}: could not push ${task.branch}: ${err.message}`);
  }

  return result;
}

/**
 * Make sure the task's worktree exists before an agent is launched into it.
 * In a fresh job it is recreated from the pushed branch; if the branch was
 * never pushed, from the base branch.
 */
export function ensureWorktree(config: FoundryConfig, task: TaskState, repoDir: string): void {
  if (git.worktreeExists(task.worktree, repoDir) && fs.existsSync(task.worktree)) return;

  try { git.fetchAll(repoDir); } catch (err: any) {
    log.warn(`Fetch failed before recreating worktree: ${err.message}`);
  }

  // A stale registration with no directory (job ended, path gone) must be pruned first.
  git.pruneWorktrees(repoDir);

  if (git.remoteBranchExists(task.branch, repoDir)) {
    git.addWorktreeTracking(task.worktree, task.branch, repoDir);
    log.info(`#${task.issue}: recreated worktree from origin/${task.branch}.`);
  } else {
    const base = resolveBaseBranch(config, repoDir);
    if (git.branchExists(task.branch, repoDir)) git.deleteBranch(task.branch, repoDir);
    git.addWorktree(task.worktree, task.branch, base, repoDir);
    log.info(`#${task.issue}: created worktree for ${task.branch} from ${base} (branch was never pushed).`);
  }
}
