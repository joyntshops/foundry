/**
 * foundry sync-integration — merge the production branch into the integration branch.
 *
 * Used after hotfix releases to keep integration current with production.
 * Branch names come from `branches:` in .joynt-foundry.yml.
 */
import { loadConfig, getConfigDir } from '../config.js';
import * as git from '../lib/git.js';
import * as log from '../lib/log.js';
import { integrationBranch, productionBranch } from '../lib/branches.js';

export async function runSyncIntegration(): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();
  const integration = integrationBranch(config);
  const production = productionBranch(config);

  log.info(`Syncing ${integration} with ${production}...`);

  // Fetch latest
  git.fetchAll(repoDir);

  // Ensure we're on the integration branch
  const branch = git.currentBranch(repoDir);
  if (branch !== integration) {
    log.error(`Must be on the integration branch (${integration}). Currently on: ${branch}`);
    log.info(`Run: git checkout ${integration}`);
    return;
  }

  // Merge production into integration
  try {
    git.merge(`origin/${production}`, repoDir);
    log.success(`Merged ${production} into ${integration}.`);
  } catch (err: any) {
    log.error(`Merge failed: ${err.message}`);
    log.info('Resolve conflicts manually, then commit and push.');
    return;
  }

  // Push
  git.push(integration, repoDir);
  log.success(`Pushed ${integration}.`);
  log.info(`${integration} is now current with ${production}.`);
}
