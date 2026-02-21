/**
 * foundry sync-integration — merge/rebase updated main into integration.
 *
 * Used after hotfix releases to keep integration current with production.
 */
import { loadConfig, getConfigDir } from '../config.js';
import * as git from '../lib/git.js';
import * as log from '../lib/log.js';

export async function runSyncIntegration(): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();

  log.info('Syncing integration with main...');

  // Fetch latest
  git.fetchAll(repoDir);

  // Ensure we're on integration
  const branch = git.currentBranch(repoDir);
  if (branch !== 'integration') {
    log.error(`Must be on integration branch. Currently on: ${branch}`);
    log.info('Run: git checkout integration');
    return;
  }

  // Merge main into integration
  try {
    git.merge('origin/main', repoDir);
    log.success('Merged main into integration.');
  } catch (err: any) {
    log.error(`Merge failed: ${err.message}`);
    log.info('Resolve conflicts manually, then commit and push.');
    return;
  }

  // Push
  git.push('integration', repoDir);
  log.success('Pushed integration.');
  log.info('Integration is now current with main.');
}
