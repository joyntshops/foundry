/**
 * Reconciliation — find tasks that claim to be running but are not.
 *
 * A job can die without a trace: the six-hour limit, a runner failure, a
 * cancel that skipped cleanup. The issue then sits at `state:in-progress`
 * forever. On a schedule, Foundry looks at every in-progress issue and, when
 * its status comment has not been touched for longer than any job could
 * live, marks it failed with a note so a human can re-queue it.
 *
 * Waiting states (`waiting-for-input`, `plan-review`, `ready-for-review`)
 * are never touched: no job is expected to be running for them.
 */
import * as github from './github.js';
import * as log from './log.js';
import * as statusComment from './status-comment.js';
import { setStateLabel } from './labels.js';
import { recoverTask } from './task-recovery.js';
import type { FoundryConfig } from '../types.js';

export const DEFAULT_STALE_MINUTES = 120;

/** Parse the `| Updated | 2026-10-21 06:35:19 UTC |` row of a status comment. */
export function parseStatusUpdatedAt(body: string): Date | null {
  const m = body.match(/\|\s*Updated\s*\|\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC\s*\|/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface StaleTask {
  issue: number;
  lastUpdate: Date | null;
  ageMinutes: number | null;
}

/** In-progress issues whose last status update is older than the threshold. */
export async function findStaleTasks(config: FoundryConfig, now: Date = new Date()): Promise<StaleTask[]> {
  const staleAfterMs = (config.reconcile_stale_minutes ?? DEFAULT_STALE_MINUTES) * 60_000;
  const issues = await github.listIssuesByLabel(config.repo, config.labels.in_progress);
  const stale: StaleTask[] = [];

  for (const issue of issues) {
    const comments = await github.getComments(config.repo, issue.number);
    const status = [...comments].reverse().find(c => c.body.includes('<!-- foundry-status -->'));
    const lastUpdate = status ? parseStatusUpdatedAt(status.body) : null;
    const ageMinutes = lastUpdate ? Math.round((now.getTime() - lastUpdate.getTime()) / 60_000) : null;
    // No status comment at all means the claim never got as far as starting an
    // agent; treat it as stale too, since nothing will ever update it.
    if (lastUpdate === null || now.getTime() - lastUpdate.getTime() > staleAfterMs) {
      stale.push({ issue: issue.number, lastUpdate, ageMinutes });
    }
  }
  return stale;
}

/** Mark each stale task failed with a note. Returns what was changed. */
export async function reconcile(config: FoundryConfig, repoDir: string, now: Date = new Date()): Promise<StaleTask[]> {
  const stale = await findStaleTasks(config, now);
  if (stale.length === 0) {
    log.info('Reconcile: every in-progress issue has a recent status update.');
    return [];
  }

  for (const s of stale) {
    const age = s.ageMinutes === null ? 'no status comment' : `last update ${s.ageMinutes} min ago`;
    log.warn(`#${s.issue} is in-progress with no live run (${age}). Marking failed.`);
    try {
      await setStateLabel(config, s.issue, 'failed');
      const task = await recoverTask(config, repoDir, s.issue);
      if (task) {
        await statusComment.updateStatusComment(config.repo, s.issue, {
          task: { ...task, status: 'failed' },
          message: `No Foundry job has reported on this issue for ${s.ageMinutes ?? 'an unknown number of'} minutes; the run that claimed it is gone (cancelled, timed out, or the runner died).\n\n\`@foundry restart\` to retry from scratch · \`@foundry start\` to re-queue`,
          historyEntry: 'Reconciled: no live run',
        });
      } else {
        await github.addComment(config.repo, s.issue, 'Foundry found this issue marked in-progress with no live run and no claim record. Marked failed; re-add `state:ready` to try again.');
      }
    } catch (err: any) {
      log.warn(`Reconcile: could not update #${s.issue}: ${err.message}`);
    }
  }
  return stale;
}
