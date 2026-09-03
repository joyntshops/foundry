/**
 * foundry reset <issue> — undo everything Foundry created for a task on GitHub
 * and put the issue back to `state:ready`.
 *
 * Works from any checkout with no local state: the task is rebuilt from the
 * issue itself (claim comment, state label, PR, preview comment). Order is
 * preview → PR → remote branch → label, so a failure part-way leaves the
 * issue in a state a human can read.
 *
 * Dry-run by default; pass --force to execute.
 */
import { loadConfigSafe, getConfigDir } from '../config.js';
import * as github from '../lib/github.js';
import * as git from '../lib/git.js';
import * as preview from '../lib/preview.js';
import * as state from '../lib/state.js';
import { recoverTask } from '../lib/task-recovery.js';
import { setStateLabel } from '../lib/labels.js';
import * as log from '../lib/log.js';

export async function runReset(issueArg: string, opts: { force?: boolean }): Promise<void> {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No .joynt-foundry.yml found. Run from the repo root.');
    return;
  }

  const issue = parseInt(issueArg, 10);
  if (isNaN(issue)) {
    log.error(`Invalid issue number: ${issueArg}`);
    return;
  }

  const repoDir = getConfigDir();
  const task = state.getTask(config.repo, issue) ?? await recoverTask(config, repoDir, issue);
  if (!task) {
    log.error(`#${issue} has never been claimed by Foundry (no claim comment). Nothing to reset.`);
    return;
  }

  const dryRun = !opts.force;
  const act = (msg: string) => log.info(`${dryRun ? '[dry-run] ' : ''}${msg}`);

  log.info(`${dryRun ? 'Dry-run reset' : 'Resetting'} #${issue}: ${task.title} (${task.status})`);

  // 1. Preview
  if (task.preview_url) {
    act(`Tear down preview: ${task.preview_url}`);
    if (!dryRun) {
      try { await preview.previewDown(config, task); } catch (err: any) { log.warn(`Preview teardown failed: ${err.message}`); }
    }
  }

  // 2. Pull request
  let prRef: number | string | undefined = task.pr_number ?? task.pr_url;
  if (prRef) {
    let open = false;
    try {
      const pr = await github.getPRStatus(config.repo, task.branch);
      open = !!pr && /^open$/i.test(pr.state);
    } catch {}
    if (open) {
      act(`Close PR ${typeof prRef === 'number' ? '#' + prRef : prRef}`);
      if (!dryRun) {
        try { await github.closePR(config.repo, prRef); } catch (err: any) { log.warn(`Close PR failed: ${err.message}`); }
      }
    } else {
      log.info('  PR: none open');
    }
  }

  // 3. Remote branch
  try { git.fetchAll(repoDir); } catch {}
  if (git.remoteBranchExists(task.branch, repoDir)) {
    act(`Delete remote branch origin/${task.branch}`);
    if (!dryRun) {
      try { git.deleteRemoteBranch(task.branch, repoDir); } catch (err: any) { log.warn(`Delete branch failed: ${err.message}`); }
    }
  } else {
    log.info(`  remote branch origin/${task.branch}: not found`);
  }

  // 4. Label
  act(`Set state label → ${config.labels.ready}`);
  if (!dryRun) await setStateLabel(config, issue, 'ready');

  // 5. Local state, if this checkout had any
  if (!dryRun) state.removeTask(config.repo, issue);

  // 6. Leave a trace on the issue
  if (!dryRun) {
    try {
      await github.addComment(config.repo, issue, [
        '**Foundry reset**',
        '',
        'Branch, PR, and preview removed. The issue is `' + config.labels.ready + '` again and will be claimed fresh.',
      ].join('\n'));
    } catch {}
  }

  log.info('');
  if (dryRun) log.info('No changes made. Run with --force to execute.');
  else log.success(`Reset complete for #${issue}.`);
}
