#!/usr/bin/env node
/**
 * Joynt Foundry CLI
 *
 * GitHub Issues → coding agent → verified pull requests.
 *
 * Foundry runs as a GitHub Action (`foundry action`, packaged by action.yml at
 * the repo root). The other commands set a repo up, operate on tasks from any
 * checkout, or manage the integration branch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { setVerbose } from './lib/log.js';
import { loadConfigSafe } from './config.js';
import { initClient } from './lib/github.js';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .name('foundry')
  .description('Joynt Foundry — GitHub Issues → coding agent → verified pull requests')
  .version(pkg.version)
  .option('-v, --verbose', 'Enable verbose/debug output')
  .option('--github-backend <backend>', 'GitHub API client: gh-cli or octokit (env: FOUNDRY_GITHUB_BACKEND)')
  .hook('preAction', async (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    // `report` is run by the agent itself and must not need GitHub credentials.
    if (actionCommand.name() === 'report') return;
    if (opts.verbose) setVerbose(true);
    if (opts.githubBackend) process.env.FOUNDRY_GITHUB_BACKEND = opts.githubBackend;
    const config = loadConfigSafe() ?? undefined;
    await initClient(config);
  });

// ── Setup ─────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold .joynt-foundry.yml, create the labels, create the integration branch')
  .option('--skip-labels', 'Skip creating GitHub labels')
  .option('--clean-labels', 'Remove non-Foundry labels before creating Foundry labels')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js');
    await runInit(opts);
  });

program
  .command('setup-bot')
  .description('Create a self-owned GitHub App for Foundry (the fallback to installing the public Foundry App)')
  .option('--server-url <url>', 'Webhook URL for the GitHub App (unused by the Action)')
  .option('--public', 'Create the public Foundry App instead (owner use; prints the owner steps and broker commands)')
  .option('--check', 'Audit an existing self-owned App: its permissions against what Foundry needs, and whether each installation accepted them. Exit 1 on any gap')
  .option('--app-id <id>', 'With --check: the App ID (default: FOUNDRY_APP_ID, or the credentials setup-bot saved)')
  .option('--private-key-file <path>', 'With --check: the App private key PEM (default: FOUNDRY_APP_PRIVATE_KEY, or the saved key)')
  .option('--name <name>', 'App name (globally unique on GitHub)')
  .option('--org <owner>', 'Owner of the App (default: the repo\'s owner)')
  .action(async (opts) => {
    const { runSetupBot } = await import('./commands/setup-bot.js');
    await runSetupBot(opts);
  });

// ── The Action entry point ────────────────────────────────────────────

program
  .command('action')
  .description('Run the state machine for one GitHub event (GitHub Actions entry point)')
  .option('--event-name <name>', 'GitHub event name (default: $GITHUB_EVENT_NAME)')
  .option('--event-path <path>', 'Path to the event JSON payload (default: $GITHUB_EVENT_PATH)')
  .action(async (opts) => {
    const { runAction } = await import('./commands/action.js');
    await runAction(opts);
  });

program
  .command('report')
  .description('Submit the agent\'s outcome report (run by the agent, for backends without structured output)')
  .requiredOption('--status <status>', 'done | needs_input | plan_ready | blocked')
  .requiredOption('--summary <text>', 'What was done, or why the agent stopped')
  .option('--assumption <text>', 'A decision made without asking (repeatable)', collect, [])
  .option('--question <text>', 'A question for the human; options after " | " separated by ";" (repeatable)', collect, [])
  .option('--plan <text>', 'The plan, for plan_ready')
  .option('--plan-file <path>', 'Read the plan from a file')
  .option('--file <path>', 'Where to write the report (default: $FOUNDRY_REPORT_FILE)')
  .action(async (opts) => {
    const { runReport } = await import('./commands/report.js');
    await runReport(opts);
  });

program
  .command('cancelled')
  .description('After a cancelled job: mark the task failed so the issue is not left in-progress (run from an `if: cancelled()` step)')
  .option('--event-name <name>', 'GitHub event name (default: $GITHUB_EVENT_NAME)')
  .option('--event-path <path>', 'Path to the event JSON payload (default: $GITHUB_EVENT_PATH)')
  .action(async (opts) => {
    const { runCancelled } = await import('./commands/cancelled.js');
    await runCancelled(opts);
  });

program
  .command('reconcile')
  .description('Mark in-progress issues with no live run as failed and tear down expired previews (also runs on the schedule trigger)')
  .action(async () => {
    const { loadConfig, getConfigDir } = await import('./config.js');
    const { reconcile } = await import('./lib/reconcile.js');
    const { reapExpiredPreviews } = await import('./lib/preview-reaper.js');
    const config = loadConfig();
    const changed = await reconcile(config, getConfigDir());
    console.log(`${changed.length} issue(s) marked failed.`);
    const reaped = await reapExpiredPreviews(config, getConfigDir());
    console.log(`${reaped.filter(r => r.tornDown).length} expired preview(s) torn down.`);
  });

// ── Operate on a task from any checkout ───────────────────────────────

program
  .command('reset <issue>')
  .description('Remove the branch, PR, and preview for a task; `@foundry go` starts it again')
  .option('--force', 'Actually execute (default is dry-run)')
  .action(async (issue, opts) => {
    const { runReset } = await import('./commands/reset.js');
    await runReset(issue, opts);
  });

const previewCmd = program
  .command('preview')
  .description('Manage a task\'s preview environment by hand');

previewCmd
  .command('up <issue>')
  .description('Trigger the preview deployment for a task')
  .action(async (issue: string) => {
    const { runPreviewUp } = await import('./commands/preview.js');
    await runPreviewUp(issue);
  });

previewCmd
  .command('down <issue>')
  .description('Tear down the preview environment for a task')
  .action(async (issue: string) => {
    const { runPreviewDown } = await import('./commands/preview.js');
    await runPreviewDown(issue);
  });

previewCmd
  .command('status <issue>')
  .description('Show preview URL, deployment id, and state for a task')
  .action(async (issue: string) => {
    const { runPreviewStatus } = await import('./commands/preview.js');
    await runPreviewStatus(issue);
  });

// ── Integration branch ────────────────────────────────────────────────

program
  .command('review <target>')
  .description('Rebase a PR onto integration, merge it, run the integration rebuild (PR number or URL)')
  .action(async (target) => {
    const { runReview } = await import('./commands/review.js');
    await runReview(target);
  });

program
  .command('release <type>')
  .description('Bump the unified version across version_sources (patch|minor|major)')
  .action(async (type) => {
    const { runRelease } = await import('./commands/release.js');
    await runRelease(type);
  });

program
  .command('sync-integration')
  .description('Merge main into integration after a hotfix release')
  .action(async () => {
    const { runSyncIntegration } = await import('./commands/sync.js');
    await runSyncIntegration();
  });

program.parse();
