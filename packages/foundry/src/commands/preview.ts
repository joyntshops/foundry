/**
 * foundry preview — manage a task's preview environment by hand.
 *
 * foundry preview up <issue>      — trigger the preview deploy
 * foundry preview down <issue>    — tear the preview down
 * foundry preview status <issue>  — show URL, deployment id, state
 *
 * The task is rebuilt from GitHub when there is no local state, so these
 * work from any checkout of the repo.
 */
import { loadConfigSafe, getConfigDir } from '../config.js';
import * as state from '../lib/state.js';
import * as preview from '../lib/preview.js';
import { recoverTask } from '../lib/task-recovery.js';
import * as log from '../lib/log.js';
import type { FoundryConfig, TaskState } from '../types.js';

async function findTask(issueArg: string): Promise<{ config: FoundryConfig; task: TaskState } | null> {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No .joynt-foundry.yml found. Run from the repo root.');
    return null;
  }

  const issueNum = parseInt(issueArg, 10);
  if (isNaN(issueNum)) {
    log.error(`Invalid issue number: ${issueArg}`);
    return null;
  }

  if (!config.preview) {
    log.error('No `preview` section in .joynt-foundry.yml.');
    return null;
  }

  const task = state.getTask(config.repo, issueNum) ?? await recoverTask(config, getConfigDir(), issueNum);
  if (!task) {
    log.error(`#${issueNum} has never been claimed by Foundry (no claim comment).`);
    return null;
  }

  return { config, task };
}

export async function runPreviewUp(issueArg: string): Promise<void> {
  const ctx = await findTask(issueArg);
  if (!ctx) return;

  log.info(`Triggering preview up for #${ctx.task.issue}...`);
  await preview.previewUp(ctx.config, ctx.task);
  log.success(`Preview up complete for #${ctx.task.issue}.`);
}

export async function runPreviewDown(issueArg: string): Promise<void> {
  const ctx = await findTask(issueArg);
  if (!ctx) return;

  if (!ctx.task.preview_url) {
    log.warn(`No preview URL found for #${ctx.task.issue}. Nothing to tear down.`);
    return;
  }

  log.info(`Tearing down preview for #${ctx.task.issue}...`);
  await preview.previewDown(ctx.config, ctx.task);
  log.success(`Preview down complete for #${ctx.task.issue}.`);
}

export async function runPreviewStatus(issueArg: string): Promise<void> {
  const ctx = await findTask(issueArg);
  if (!ctx) return;

  const status = preview.getPreviewStatus(ctx.config, ctx.task);

  console.log('');
  console.log(`  Issue:         #${ctx.task.issue}`);
  console.log(`  Preview URL:   ${status.url ?? '—'}`);
  console.log(`  Deployment ID: ${status.deploymentId ?? '—'}`);
  console.log(`  State:         ${status.state}`);
  console.log('');
}
