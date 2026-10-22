/**
 * foundry review <pr|url> — the approve-button flow, from a checkout.
 *
 * Same code as the pr_approved event under the Action: rebase onto the base,
 * wait for checks, merge with the rebase method, run integration_rebuild.
 */
import { loadConfig, getConfigDir } from '../config.js';
import * as github from '../lib/github.js';
import * as log from '../lib/log.js';
import { integrationBranch } from '../lib/branches.js';
import { reviewAndMerge } from '../lib/review.js';

export async function runReview(target: string): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();

  const m = String(target).match(/(\d+)\/?$/);
  if (!m) {
    log.error(`Cannot parse target: ${target}`);
    return;
  }
  const pr = parseInt(m[1], 10);

  let branch: string;
  try {
    branch = await github.getPRBranch(config.repo, pr);
  } catch (err: any) {
    log.error(`Failed to get PR #${pr}: ${err.message}`);
    return;
  }

  const outcome = await reviewAndMerge(config, repoDir, { pr_number: pr, branch, base: integrationBranch(config) });
  if (!outcome.merged) {
    log.error(`PR #${pr} not merged: ${outcome.reason} (${outcome.detail})`);
    process.exitCode = 1;
    return;
  }
  log.success(`Review complete for PR #${pr}.`);
}
