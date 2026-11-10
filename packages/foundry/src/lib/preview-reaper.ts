/**
 * Preview expiry — tear down previews whose `preview.ttl_hours` has passed.
 *
 * Runs on the schedule trigger, next to reconcile. Jobs are stateless, so
 * the record is the preview comment on each pull request: a live comment
 * carries its expiry, and this module reads every open pull request's
 * comment to find the ones that are past it. A reaped preview's comment says
 * it expired and how to bring it back.
 *
 * Granularity is the workflow's `schedule:` interval: a preview lives until
 * the first scheduled run after its expiry.
 */
import * as github from './github.js';
import * as log from './log.js';
import * as preview from './preview.js';
import { integrationBranch } from './branches.js';
import { issueNumberFromBranch, recoverTask } from './task-recovery.js';
import type { FoundryConfig } from '../types.js';

export interface ReapedPreview {
  pr_number: number;
  branch: string;
  url: string;
  expiresAt: string;
  /** False when the provider's down command failed; the comment is left live for the next run. */
  tornDown: boolean;
}

export async function reapExpiredPreviews(config: FoundryConfig, repoDir: string, now: Date = new Date()): Promise<ReapedPreview[]> {
  if (!config.preview) return [];

  const bases = [...new Set([integrationBranch(config), ...(config.preview.pull_request_bases ?? [])])];
  const seen = new Set<number>();
  const reaped: ReapedPreview[] = [];

  for (const base of bases) {
    let prs: Array<{ number: number; head: string }>;
    try {
      prs = await github.listOpenPRs(config.repo, base);
    } catch (err: any) {
      log.warn(`Preview expiry: could not list open pull requests into ${base}: ${err.message}`);
      continue;
    }

    for (const pr of prs) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);

      const record = await preview.findPreviewOnPR(config.repo, pr.number);
      if (!record?.expiresAt || !preview.isExpired(record.expiresAt, now)) continue;

      // The task behind the PR, when there is one: its issue number goes to
      // the down command and into the "bring it back" line.
      let issue: number | undefined;
      const fromBranch = issueNumberFromBranch(config.branch_template, pr.head);
      if (fromBranch !== null) {
        try {
          const task = await recoverTask(config, repoDir, fromBranch);
          if (task && task.branch === pr.head) issue = task.issue;
        } catch {}
      }
      let sha = '';
      try { sha = (await github.getPR(config.repo, pr.number)).sha; } catch {}

      log.info(`Preview on PR #${pr.number} (${pr.head}) expired at ${record.expiresAt}. Tearing down.`);
      let tornDown = false;
      try {
        tornDown = await preview.previewDownTarget(config, {
          branch: pr.head,
          pr_number: pr.number,
          issue,
          sha,
          preview_url: record.url,
        }, 'expired');
      } catch (err: any) {
        log.warn(`Preview expiry: teardown failed for PR #${pr.number}: ${err.message}`);
      }
      if (!tornDown) log.warn(`Preview on PR #${pr.number} is past its expiry but could not be torn down; the next scheduled run tries again.`);
      reaped.push({ pr_number: pr.number, branch: pr.head, url: record.url, expiresAt: record.expiresAt, tornDown });
    }
  }
  return reaped;
}
