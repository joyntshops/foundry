/**
 * foundry prune — clean local runner resources for stale tasks.
 *
 * Local-only cleanup (tmux, worktrees, local branches, state).
 * Non-destructive by default (dry-run). Use --all to actually clean.
 */
import { loadConfigSafe, getConfigDir } from '../config.js';
import * as state from '../lib/state.js';
import * as tmux from '../lib/tmux.js';
import * as git from '../lib/git.js';
import * as log from '../lib/log.js';

export async function runPrune(opts: { all?: boolean; force?: boolean }): Promise<void> {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No .joynt-foundry.yml found.');
    return;
  }

  const repoDir = getConfigDir();
  const dryRun = !opts.all && !opts.force;

  if (dryRun) {
    log.info('Dry run — use --all to actually clean. Showing what would be removed:');
    log.info('');
  }

  const tasks = state.getAllTasks(config.repo);
  const staleTasks = tasks.filter(
    t => ['done', 'failed', 'stopped'].includes(t.status)
  );

  let cleaned = 0;

  for (const task of staleTasks) {
    log.info(`  #${task.issue} (${task.status}): ${task.title}`);

    // Kill tmux session if still alive
    if (tmux.sessionExists(task.tmux_session)) {
      log.info(`    tmux: ${task.tmux_session} — would kill`);
      if (!dryRun) {
        tmux.killSession(task.tmux_session);
        log.success(`    Killed tmux: ${task.tmux_session}`);
      }
    }

    // Remove worktree
    if (task.worktree) {
      const exists = git.worktreeExists(task.worktree, repoDir);
      if (exists) {
        log.info(`    worktree: ${task.worktree} — would remove`);
        if (!dryRun) {
          try {
            git.removeWorktree(task.worktree, repoDir);
            log.success(`    Removed worktree: ${task.worktree}`);
          } catch (err: any) {
            log.warn(`    Failed to remove worktree: ${err.message}`);
          }
        }
      }
    }

    // Delete local branch
    if (task.branch) {
      if (git.branchExists(task.branch, repoDir)) {
        log.info(`    branch: ${task.branch} — would delete`);
        if (!dryRun) {
          try {
            git.deleteBranch(task.branch, repoDir);
            log.success(`    Deleted branch: ${task.branch}`);
          } catch (err: any) {
            log.warn(`    Failed to delete branch: ${err.message}`);
          }
        }
      }
    }

    // Remove from state
    if (!dryRun) {
      state.removeTask(config.repo, task.issue);
      log.success(`    Removed from state.`);
    }

    cleaned++;
  }

  if (cleaned === 0) {
    log.info('Nothing to prune.');
  } else if (dryRun) {
    log.info('');
    log.info(`Would prune ${cleaned} task(s). Run with --all to execute.`);
  } else {
    log.success(`Pruned ${cleaned} task(s).`);
  }
}
