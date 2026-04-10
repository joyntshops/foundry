/**
 * foundry run — main runner loop.
 *
 * Thin composition layer that wires Poller → EventHandler.
 * All event detection lives in Poller, all handling in EventHandler.
 */
import { loadConfig, getConfigDir } from '../config.js';
import { resolveWorker } from '../lib/workers/index.js';
import * as state from '../lib/state.js';
import * as claim from '../lib/claim.js';
import * as log from '../lib/log.js';
import * as statusComment from '../lib/status-comment.js';
import type { FoundryConfig } from '../types.js';
import { EventHandler } from '../lib/event-handler.js';
import { Poller } from '../lib/poller.js';

let running = true;

export async function runRunner(opts: { once?: boolean }): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();
  const runnerId = state.getRunnerId();

  log.info(`Foundry runner starting — ${runnerId}`);
  log.info(`Repo: ${config.repo}`);
  log.info(`Max sessions: ${config.max_sessions}`);
  log.info(`Polling interval: ${config.poll_interval_seconds}s`);
  log.info('');

  // Graceful shutdown
  process.on('SIGINT', () => {
    log.warn('Shutting down (SIGINT)...');
    running = false;
  });
  process.on('SIGTERM', () => {
    log.warn('Shutting down (SIGTERM)...');
    running = false;
  });

  // Reconcile on startup
  await reconcile(config);

  // Compose Poller + EventHandler
  const handler = new EventHandler(config, repoDir);
  const poller = new Poller(config, repoDir, handler, () => running);

  // Main loop
  while (running) {
    try {
      await poller.poll();
    } catch (err: any) {
      log.error(`Poll error: ${err.message}`);
    }

    if (opts.once) break;

    // Wait for next poll
    await sleep(config.poll_interval_seconds * 1000);
  }

  log.info('Runner stopped.');
}

async function reconcile(config: FoundryConfig): Promise<void> {
  log.info('Reconciling state...');
  const worker = resolveWorker(config.worker?.type);
  const tasks = state.getAllTasks(config.repo);

  for (const task of tasks) {
    if (['done', 'failed', 'stopped'].includes(task.status)) continue;

    // Waiting/pr-changes-requested/plan-review/claimed tasks are valid without a tmux session
    if (['waiting-for-input', 'pr-changes-requested', 'plan-review', 'claimed'].includes(task.status)) continue;

    const handle = worker.handleFor(task.tmux_session);

    // If resuming but worker is dead, revert to waiting-for-input
    if (task.status === 'resuming' && !(await handle.isRunning())) {
      log.warn(`Resume session ${task.tmux_session} for #${task.issue} is dead. Reverting to waiting-for-input.`);
      state.updateTaskStatus(config.repo, task.issue, 'waiting-for-input');
      continue;
    }

    // Check if worker is still alive
    if (!(await handle.isRunning())) {
      log.warn(`Session ${task.tmux_session} for #${task.issue} is dead. Marking stopped.`);
      state.updateTaskStatus(config.repo, task.issue, 'stopped');
      await claim.markFailed(config, task.issue);
      const stoppedTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'stopped' as const };
      await statusComment.updateStatusComment(config.repo, task.issue, {
        task: stoppedTask,
        message: `Worker session \`${task.tmux_session}\` exited unexpectedly during reconciliation.\n\n\`@foundry restart\` to retry from scratch · \`@foundry start\` to re-queue`,
        historyEntry: 'Session died unexpectedly',
      });
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
