/**
 * foundry status — show active tasks, sessions, branches, PRs, agent backend.
 */
import { loadConfig, loadConfigSafe } from '../config.js';
import * as state from '../lib/state.js';
import * as tmux from '../lib/tmux.js';
import * as log from '../lib/log.js';

export async function runStatus(): Promise<void> {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No .joynt-foundry.yml found. Run `foundry init` first.');
    return;
  }

  const runnerId = state.getRunnerId();
  log.info(`Runner: ${runnerId}`);
  log.info(`Repo:   ${config.repo}`);
  log.info('');

  const tasks = state.getAllTasks(config.repo);
  const activeTasks = tasks.filter(
    t => !['done', 'failed', 'stopped'].includes(t.status)
  );

  if (activeTasks.length === 0) {
    log.info('No active tasks.');
    return;
  }

  log.info(`Active tasks: ${activeTasks.length} / ${config.max_sessions} max`);
  log.info('');

  for (const task of activeTasks) {
    const tmuxAlive = tmux.sessionExists(task.tmux_session);
    console.log(`  #${task.issue}  ${task.title}`);
    console.log(`    Status:   ${task.status}`);
    console.log(`    Branch:   ${task.branch}`);
    console.log(`    Worktree: ${task.worktree}`);
    console.log(`    tmux:     ${task.tmux_session} (${tmuxAlive ? 'alive' : 'dead'})`);
    console.log(`    Backend:  ${task.agent_backend}`);
    if (task.pr_url) {
      console.log(`    PR:       ${task.pr_url}`);
    }
    console.log(`    Claimed:  ${task.claimed_at}`);
    console.log('');
  }

  // Show completed/stopped tasks summary
  const finishedTasks = tasks.filter(
    t => ['done', 'failed', 'stopped'].includes(t.status)
  );
  if (finishedTasks.length > 0) {
    log.info(`Finished tasks: ${finishedTasks.length}`);
    for (const task of finishedTasks.slice(-5)) {
      console.log(`  #${task.issue}  ${task.status}  ${task.title}`);
    }
  }
}
