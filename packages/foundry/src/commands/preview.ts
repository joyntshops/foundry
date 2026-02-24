/**
 * foundry preview — manage preview environments.
 *
 * foundry preview up <issue>      — trigger preview deploy
 * foundry preview down <issue>    — tear down preview
 * foundry preview status <issue>  — show preview URL, deployment ID, state
 */
import { loadConfigSafe } from '../config.js';
import * as state from '../lib/state.js';
import * as preview from '../lib/preview.js';
import * as log from '../lib/log.js';

function findTask(issueArg: string) {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No config found. Run `foundry init` first.');
    return null;
  }

  const issueNum = parseInt(issueArg, 10);
  if (isNaN(issueNum)) {
    log.error(`Invalid issue number: ${issueArg}`);
    return null;
  }

  const tasks = state.getAllTasks(config.repo);
  const task = tasks.find(t => t.issue === issueNum);
  if (!task) {
    log.error(`No task found for issue #${issueNum} in state.`);
    return null;
  }

  if (!config.preview) {
    log.error('No preview configuration found in .joynt-foundry.yml.');
    return null;
  }

  return { config, task };
}

export async function runPreviewUp(issueArg: string): Promise<void> {
  const ctx = findTask(issueArg);
  if (!ctx) return;

  log.info(`Triggering preview up for #${ctx.task.issue}...`);
  await preview.previewUp(ctx.config, ctx.task);
  log.success(`Preview up complete for #${ctx.task.issue}.`);
}

export async function runPreviewDown(issueArg: string): Promise<void> {
  const ctx = findTask(issueArg);
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
  const ctx = findTask(issueArg);
  if (!ctx) return;

  const status = preview.getPreviewStatus(ctx.config, ctx.task);

  console.log('');
  console.log(`  Issue:         #${ctx.task.issue}`);
  console.log(`  Preview URL:   ${status.url ?? '—'}`);
  console.log(`  Deployment ID: ${status.deploymentId ?? '—'}`);
  console.log(`  State:         ${status.state}`);
  console.log('');
}
