/**
 * foundry cancelled — the job was cancelled; leave the issue honest.
 *
 * Runs from a workflow step guarded by `if: cancelled()`. The agent process
 * is already gone. Whatever the task was doing, the issue must not stay at
 * `state:in-progress`: that label is read as "a job is running".
 */
import * as fs from 'node:fs';
import { loadConfig, getConfigDir } from '../config.js';
import * as github from '../lib/github.js';
import * as preview from '../lib/preview.js';
import * as statusComment from '../lib/status-comment.js';
import { setStateLabel } from '../lib/labels.js';
import { recoverTask, issueNumberFromPayload } from '../lib/task-recovery.js';
import { preserveWork } from '../lib/worktree.js';
import * as log from '../lib/log.js';

export async function runCancelled(opts: { eventName?: string; eventPath?: string }): Promise<void> {
  const eventName = opts.eventName ?? process.env.GITHUB_EVENT_NAME ?? '';
  const eventPath = opts.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    log.warn('foundry cancelled: no event payload; nothing to clean up.');
    return;
  }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf-8')) as Record<string, any>;
  const config = loadConfig();
  const issue = issueNumberFromPayload(payload, config);
  if (issue === null) {
    log.info(`foundry cancelled: ${eventName} names no issue; nothing to clean up.`);
    return;
  }

  const task = await recoverTask(config, getConfigDir(), issue);
  if (!task) {
    log.info(`foundry cancelled: #${issue} was never claimed; nothing to clean up.`);
    return;
  }

  // Only a task a job was actively working on needs correcting.
  const live = task.status === 'agent-running' || task.status === 'verifying' || task.status === 'resuming';
  if (!live) {
    log.info(`foundry cancelled: #${issue} is ${task.status}; no live run to clean up.`);
    return;
  }

  log.warn(`Run for #${issue} was cancelled. Marking failed.`);
  // This step runs inside the cancelled job, so the worktree is still here.
  const preserved = preserveWork(task, getConfigDir(), 'run cancelled');
  await setStateLabel(config, issue, 'failed');
  if (task.preview_url) {
    try { await preview.previewDown(config, task); } catch {}
  }
  try {
    await statusComment.updateStatusComment(config.repo, issue, {
      task: { ...task, status: 'failed' },
      message: [
        'The run was cancelled before the agent finished.',
        preserved.pushed ? `Work so far is on \`${task.branch}\`.` : 'Nothing was pushed.',
        '',
        '`@foundry go` to continue from the branch · `@foundry restart` to start over',
      ].join('\n'),
      historyEntry: 'Run cancelled',
    });
  } catch (err: any) {
    try { await github.addComment(config.repo, issue, `Foundry: the run was cancelled. Marked failed. (${err.message})`); } catch {}
  }
}
