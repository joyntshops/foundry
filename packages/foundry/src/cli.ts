#!/usr/bin/env node
/**
 * Joynt Foundry CLI
 *
 * Developer automation: GitHub Issues → agent sessions → validated PRs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { setVerbose } from './lib/log.js';
import { loadConfigSafe } from './config.js';
import { initClient } from './lib/github.js';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('foundry')
  .description('Joynt Foundry — developer automation via GitHub Issues and pluggable coding agents')
  .version(pkg.version)
  .option('-v, --verbose', 'Enable verbose/debug output')
  .option('--github-backend <backend>', 'GitHub backend: gh-cli or octokit (env: FOUNDRY_GITHUB_BACKEND)')
  .hook('preAction', async (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setVerbose(true);
    if (opts.githubBackend) process.env.FOUNDRY_GITHUB_BACKEND = opts.githubBackend;
    const config = loadConfigSafe() ?? undefined;
    await initClient(config);
  });

// ── foundry setup-bot ────────────────────────────────────────────────

program
  .command('setup-bot')
  .description('Create a GitHub App for Foundry and install it on your repos')
  .action(async () => {
    const { runSetupBot } = await import('./commands/setup-bot.js');
    await runSetupBot();
  });

// ── foundry init ──────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold .joynt-foundry.yml and create required GitHub labels')
  .option('--skip-labels', 'Skip creating GitHub labels')
  .option('--clean-labels', 'Remove non-Foundry labels before creating Foundry labels')
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js');
    await runInit(opts);
  });

// ── foundry run ───────────────────────────────────────────────────────

program
  .command('run')
  .description('Start the runner loop: poll → claim → spawn agent sessions')
  .option('--once', 'Run a single poll cycle then exit')
  .action(async (opts) => {
    const { runRunner } = await import('./commands/run.js');
    await runRunner(opts);
  });

// ── foundry status ────────────────────────────────────────────────────

program
  .command('status')
  .description('Show active tasks, sessions, branches, PRs, and agent backends')
  .action(async () => {
    const { runStatus } = await import('./commands/status.js');
    await runStatus();
  });

// ── foundry sessions ──────────────────────────────────────────────────

program
  .command('sessions')
  .description('Show unified task dashboard (all tracked tasks and their resources)')
  .option('--all', 'Include terminal tasks (done/failed/stopped)')
  .option('--local', 'Skip GitHub API calls, only show local resource state')
  .action(async (opts) => {
    const { runSessions } = await import('./commands/sessions.js');
    await runSessions(opts);
  });

// ── foundry attach ────────────────────────────────────────────────────

program
  .command('attach <target>')
  .description('Attach to a Foundry agent session (issue number or session name)')
  .action(async (target) => {
    const { runAttach } = await import('./commands/sessions.js');
    await runAttach(target);
  });

// ── foundry stop ──────────────────────────────────────────────────────

program
  .command('stop <target>')
  .description('Stop a Foundry agent session (issue number or session name)')
  .option('--ready', 'Restore the state:ready label so the runner re-claims immediately')
  .action(async (target, opts) => {
    const { runStop } = await import('./commands/sessions.js');
    await runStop(target, opts);
  });

// ── foundry reset ─────────────────────────────────────────────────────

program
  .command('reset [issue]')
  .description('Tear down all resources (local + remote) for a task and restore to state:ready')
  .option('--force', 'Actually execute (default is dry-run)')
  .option('--all', 'Reset all known tasks (iterates task directories)')
  .action(async (issue, opts) => {
    if (!issue && !opts.all) {
      console.error('Error: provide an issue number, or use --all to reset all tasks.');
      process.exit(1);
    }
    const { runReset } = await import('./commands/sessions.js');
    await runReset(issue, opts);
  });

// ── foundry prune ─────────────────────────────────────────────────────

program
  .command('prune')
  .description('Clean local runner resources (tmux, worktrees, local branches, state) for completed/failed tasks')
  .option('--all', 'Actually remove (default is dry-run)')
  .option('--force', 'Alias for --all (backwards compat)')
  .action(async (opts) => {
    const { runPrune } = await import('./commands/prune.js');
    await runPrune(opts);
  });

// ── foundry review ────────────────────────────────────────────────────

program
  .command('review <target>')
  .description('Review and merge a PR into integration (PR number or URL)')
  .action(async (target) => {
    const { runReview } = await import('./commands/review.js');
    await runReview(target);
  });

// ── foundry release ───────────────────────────────────────────────────

program
  .command('release <type>')
  .description('Bump version across all version_sources (patch|minor|major)')
  .action(async (type) => {
    const { runRelease } = await import('./commands/release.js');
    await runRelease(type);
  });

// ── foundry preview ──────────────────────────────────────────────────

const previewCmd = program
  .command('preview')
  .description('Manage preview environments for tasks');

previewCmd
  .command('up <issue>')
  .description('Trigger preview deployment for a task')
  .action(async (issue: string) => {
    const { runPreviewUp } = await import('./commands/preview.js');
    await runPreviewUp(issue);
  });

previewCmd
  .command('down <issue>')
  .description('Tear down preview environment for a task')
  .action(async (issue: string) => {
    const { runPreviewDown } = await import('./commands/preview.js');
    await runPreviewDown(issue);
  });

previewCmd
  .command('status <issue>')
  .description('Show preview environment status for a task')
  .action(async (issue: string) => {
    const { runPreviewStatus } = await import('./commands/preview.js');
    await runPreviewStatus(issue);
  });

// ── foundry sync-integration ──────────────────────────────────────────

program
  .command('sync-integration')
  .description('Merge updated main into integration (after hotfix releases)')
  .action(async () => {
    const { runSyncIntegration } = await import('./commands/sync.js');
    await runSyncIntegration();
  });

program.parse();
