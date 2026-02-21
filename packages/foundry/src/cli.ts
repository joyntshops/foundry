#!/usr/bin/env node
/**
 * Joynt Foundry CLI
 *
 * Developer automation: GitHub Issues → agent sessions → validated PRs.
 */
import { Command } from 'commander';
import { setVerbose } from './lib/log.js';

const program = new Command();

program
  .name('foundry')
  .description('Joynt Foundry — developer automation via GitHub Issues and pluggable coding agents')
  .version('0.1.0')
  .option('-v, --verbose', 'Enable verbose/debug output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setVerbose(true);
  });

// ── foundry init ──────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold .joynt-foundry.yml and create required GitHub labels')
  .option('--skip-labels', 'Skip creating GitHub labels')
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
  .description('List Foundry tmux sessions')
  .action(async () => {
    const { runSessions } = await import('./commands/sessions.js');
    await runSessions();
  });

// ── foundry attach ────────────────────────────────────────────────────

program
  .command('attach <target>')
  .description('Attach to a Foundry tmux session (issue number or session name)')
  .action(async (target) => {
    const { runAttach } = await import('./commands/sessions.js');
    await runAttach(target);
  });

// ── foundry stop ──────────────────────────────────────────────────────

program
  .command('stop <target>')
  .description('Stop a Foundry session safely (issue number or session name)')
  .action(async (target) => {
    const { runStop } = await import('./commands/sessions.js');
    await runStop(target);
  });

// ── foundry prune ─────────────────────────────────────────────────────

program
  .command('prune')
  .description('Clean stale state, worktrees, and tmux sessions')
  .option('--force', 'Actually remove (default is dry-run)')
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

// ── foundry sync-integration ──────────────────────────────────────────

program
  .command('sync-integration')
  .description('Merge updated main into integration (after hotfix releases)')
  .action(async () => {
    const { runSyncIntegration } = await import('./commands/sync.js');
    await runSyncIntegration();
  });

program.parse();
