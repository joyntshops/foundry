/**
 * foundry review <pr|issue> — integration review flow.
 *
 * - Ensure mergeability
 * - Rebase feature branch onto integration for linear history
 * - Push updated branch
 * - Merge into integration
 * - Run integration rebuild
 * - Update issue label
 */
import { loadConfig, getConfigDir } from '../config.js';
import * as github from '../lib/github.js';
import * as git from '../lib/git.js';
import * as verifyLib from '../lib/verify.js';
import * as log from '../lib/log.js';

export async function runReview(target: string): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();

  // Determine PR number
  let prNumber: string;
  const parsed = parseInt(target, 10);
  if (isNaN(parsed)) {
    // Could be a URL — extract the number
    const m = target.match(/\/(\d+)\/?$/);
    if (!m) {
      log.error(`Cannot parse target: ${target}`);
      return;
    }
    prNumber = m[1];
  } else {
    prNumber = String(parsed);
  }

  log.info(`Reviewing PR/issue #${prNumber}...`);

  // Check mergeability
  if (!await github.isPRMergeable(config.repo, prNumber)) {
    log.error(`PR #${prNumber} is not mergeable. Resolve conflicts first.`);
    return;
  }

  log.success('PR is mergeable.');

  // Get PR details to find the branch
  let prBranch: string;
  try {
    prBranch = await github.getPRBranch(config.repo, prNumber);
  } catch (err: any) {
    log.error(`Failed to get PR details: ${err.message}`);
    return;
  }

  // Fetch latest
  git.fetchAll(repoDir);

  // Rebase feature branch onto integration
  log.info(`Rebasing ${prBranch} onto integration...`);
  try {
    // Create a temporary worktree for the rebase
    const tmpPath = git.resolveWorktreePath(config.worktree_base, parseInt(prNumber), 'review', repoDir);

    if (git.worktreeExists(tmpPath, repoDir)) {
      git.removeWorktree(tmpPath, repoDir);
    }

    git.addWorktree(tmpPath, prBranch, `origin/${prBranch}`, repoDir);
    git.rebase('origin/integration', tmpPath);
    git.push(prBranch, tmpPath, true); // force-with-lease
    log.success('Rebased and pushed.');

    // Merge into integration
    log.info('Merging into integration...');
    await github.mergePR(config.repo, prNumber, 'rebase');
    log.success('Merged into integration.');

    // Clean up worktree
    git.removeWorktree(tmpPath, repoDir);
  } catch (err: any) {
    log.error(`Rebase/merge failed: ${err.message}`);
    return;
  }

  // Run integration rebuild
  if (config.integration_rebuild) {
    log.info('Running integration rebuild...');
    git.fetchAll(repoDir);

    const result = verifyLib.runIntegrationRebuild(config, repoDir);
    if (result && !result.success) {
      log.error('Integration rebuild failed!');
      log.error(result.output.slice(-1000));
      return;
    }
    log.success('Integration rebuild passed.');
  }

  // Update issue labels
  try {
    await github.addLabel(config.repo, parseInt(prNumber), config.labels.ready_for_review);
  } catch {
    // best effort
  }
  try {
    await github.removeLabel(config.repo, parseInt(prNumber), config.labels.in_progress);
  } catch {
    // best effort — label may not exist
  }

  log.success(`Review complete for #${prNumber}.`);
}
