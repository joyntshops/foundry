/**
 * foundry sessions — unified task dashboard.
 * foundry attach  — attach to a session.
 * foundry stop    — stop a session safely.
 * foundry reset   — tear down all resources for a task and restore to ready.
 */
import { loadConfigSafe } from '../config.js';
import * as state from '../lib/state.js';
import * as tmux from '../lib/tmux.js';
import * as git from '../lib/git.js';
import * as github from '../lib/github.js';
import * as claim from '../lib/claim.js';
import * as log from '../lib/log.js';
import type { FoundryConfig, TaskState } from '../types.js';

// ── foundry sessions ─────────────────────────────────────────────────────

export async function runSessions(opts?: { all?: boolean; local?: boolean }): Promise<void> {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No config found. Run `foundry init` first.');
    return;
  }

  const tasks = state.getAllTasks(config.repo);
  const terminalStatuses = ['done', 'failed', 'stopped'];

  const filtered = opts?.all
    ? tasks
    : tasks.filter(t => !terminalStatuses.includes(t.status));

  if (filtered.length === 0) {
    log.info(opts?.all ? 'No tracked tasks.' : 'No active tasks. Use --all to include terminal tasks.');
    return;
  }

  // Resolve the repo root for worktree checks
  let repoDir: string | undefined;
  try { repoDir = git.repoRoot(); } catch {}

  // Header
  console.log('');
  console.log(`  ${'#'.padEnd(6)} ${'Title'.padEnd(32)} ${'Status'.padEnd(22)} ${'Session'.padEnd(16)} ${'Worktree'.padEnd(9)} ${'PR'.padEnd(10)} ${opts?.local ? '' : 'Labels'}`);
  console.log(`  ${'─'.repeat(6)} ${'─'.repeat(32)} ${'─'.repeat(22)} ${'─'.repeat(16)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${opts?.local ? '' : '─'.repeat(30)}`);

  for (const task of filtered) {
    // Issue # column (the identifier for foundry attach/stop/reset)
    const issueId = String(task.issue).padEnd(6);

    // Title column
    const titleTrunc = (task.title.length > 30 ? task.title.slice(0, 27) + '...' : task.title).padEnd(32);

    // Status column
    const statusCol = task.status.padEnd(22);

    // Session column — tmux session name + alive/dead status
    let sessionStatus: string;
    try {
      sessionStatus = tmux.sessionExists(task.tmux_session) ? 'alive' : 'dead';
    } catch {
      sessionStatus = '—';
    }
    const sessionCol = `${task.tmux_session} (${sessionStatus})`.padEnd(16);

    // Worktree column
    let wtCol = '—';
    try {
      wtCol = git.worktreeExists(task.worktree, repoDir) ? 'exists' : '—';
    } catch {}
    wtCol = wtCol.padEnd(9);

    // PR column
    let prCol = '—';
    if (task.pr_url) {
      if (opts?.local) {
        prCol = task.pr_number ? `#${task.pr_number}` : 'yes';
      } else {
        try {
          const prStatus = await github.getPRStatus(config.repo, task.branch);
          prCol = prStatus ? prStatus.state : '—';
        } catch {
          prCol = '?';
        }
      }
    }
    prCol = prCol.padEnd(10);

    // Labels column (skip in local mode)
    let labelsCol = '';
    if (!opts?.local) {
      try {
        const issue = await github.getIssue(config.repo, task.issue);
        const foundryLabels = issue.labels
          .map(l => l.name)
          .filter(n => n.startsWith('state:') || n.startsWith('spec:'));
        labelsCol = foundryLabels.join(', ');
      } catch {
        labelsCol = '?';
      }
    }

    console.log(`  ${issueId} ${titleTrunc} ${statusCol} ${sessionCol} ${wtCol} ${prCol} ${labelsCol}`);
  }
  console.log('');
  console.log('  Commands: foundry attach <#> | foundry stop <#> | foundry reset <#>');
  console.log('');
}

// ── foundry attach ───────────────────────────────────────────────────────

export async function runAttach(target: string): Promise<void> {
  const config = loadConfigSafe();
  let sessionName: string;

  // target can be an issue number or a tmux session name
  const issueNum = parseInt(target, 10);
  if (!isNaN(issueNum) && config) {
    const tasks = state.getAllTasks(config.repo);
    const task = tasks.find(t => t.issue === issueNum);
    if (!task) {
      log.error(`No task found for issue #${issueNum}`);
      return;
    }
    sessionName = task.tmux_session;
  } else {
    sessionName = target;
  }

  if (!tmux.sessionExists(sessionName)) {
    log.error(`tmux session "${sessionName}" does not exist.`);
    return;
  }

  log.info(`Attaching to ${sessionName}...`);
  log.info('Tip: Press Ctrl+b then d to detach and return to your shell.');
  tmux.attachSession(sessionName);
}

// ── foundry stop ─────────────────────────────────────────────────────────

export async function runStop(target: string, opts?: { ready?: boolean }): Promise<void> {
  const config = loadConfigSafe();
  let sessionName: string;
  let issueNum: number | null = null;

  const parsed = parseInt(target, 10);
  if (!isNaN(parsed) && config) {
    issueNum = parsed;
    const tasks = state.getAllTasks(config.repo);
    const task = tasks.find(t => t.issue === parsed);
    if (!task) {
      log.error(`No task found for issue #${parsed}`);
      return;
    }
    sessionName = task.tmux_session;
  } else {
    sessionName = target;
  }

  if (tmux.sessionExists(sessionName)) {
    log.info(`Sending interrupt to ${sessionName}...`);
    tmux.sendInterrupt(sessionName);
    // Give agent a moment to clean up
    await new Promise(r => setTimeout(r, 2000));
    log.info(`Killing session ${sessionName}...`);
    tmux.killSession(sessionName);
    log.success(`Session ${sessionName} stopped.`);
  } else {
    log.warn(`tmux session "${sessionName}" not found.`);
  }

  if (issueNum && config) {
    state.updateTaskStatus(config.repo, issueNum, 'stopped');
    if (opts?.ready) {
      try { await github.removeLabel(config.repo, issueNum, config.labels.in_progress); } catch {}
      try { await github.addLabel(config.repo, issueNum, config.labels.ready); } catch {}
      log.info(`Task #${issueNum} stopped. Label restored to ${config.labels.ready}.`);
    } else {
      await claim.markFailed(config, issueNum);
      log.info(`Task #${issueNum} stopped. Label set to ${config.labels.failed}.`);
    }
  }
}

// ── foundry reset ────────────────────────────────────────────────────────

export async function runReset(issueArg: string, opts?: { force?: boolean }): Promise<void> {
  const config = loadConfigSafe();
  if (!config) {
    log.error('No config found. Run `foundry init` first.');
    return;
  }

  const issueNum = parseInt(issueArg, 10);
  if (isNaN(issueNum)) {
    log.error(`Invalid issue number: ${issueArg}`);
    return;
  }

  const tasks = state.getAllTasks(config.repo);
  const task = tasks.find(t => t.issue === issueNum);
  if (!task) {
    log.error(`No task found for issue #${issueNum} in state.`);
    return;
  }

  let repoDir: string | undefined;
  try { repoDir = git.repoRoot(); } catch {}

  const dryRun = !opts?.force;

  if (dryRun) {
    log.info(`Dry-run reset for #${issueNum}. Use --force to execute.`);
    log.info('');
  } else {
    log.info(`Resetting #${issueNum}...`);
    log.info('');
  }

  // 1. tmux session
  const tmuxAlive = tmux.sessionExists(task.tmux_session);
  if (tmuxAlive) {
    logAction(dryRun, `Kill tmux session: ${task.tmux_session}`);
    if (!dryRun) tmux.killSession(task.tmux_session);
  } else {
    log.info(`  tmux: ${task.tmux_session} — not running`);
  }

  // 2. Worktree
  const wtExists = repoDir ? git.worktreeExists(task.worktree, repoDir) : false;
  if (wtExists) {
    logAction(dryRun, `Remove worktree: ${task.worktree}`);
    if (!dryRun) git.removeWorktree(task.worktree, repoDir);
  } else {
    log.info('  worktree: not found');
  }

  // 3. Local branch
  const branchExists = repoDir ? git.branchExists(task.branch, repoDir) : false;
  if (branchExists) {
    logAction(dryRun, `Delete local branch: ${task.branch}`);
    if (!dryRun) git.deleteBranch(task.branch, repoDir);
  } else {
    log.info(`  local branch: ${task.branch} — not found`);
  }

  // 4. Remote branch
  const remoteBranchExists = repoDir ? git.remoteBranchExists(task.branch, repoDir) : false;
  if (remoteBranchExists) {
    logAction(dryRun, `Delete remote branch: origin/${task.branch}`);
    if (!dryRun) git.deleteRemoteBranch(task.branch, repoDir);
  } else {
    log.info(`  remote branch: origin/${task.branch} — not found`);
  }

  // 5. PR
  let prOpen = false;
  if (task.pr_url) {
    try {
      const prStatus = await github.getPRStatus(config.repo, task.branch);
      prOpen = prStatus?.state === 'OPEN' || prStatus?.state === 'open';
    } catch {}
  }
  if (prOpen) {
    const prId = task.pr_number ?? task.pr_url;
    logAction(dryRun, `Close PR: ${prId}`);
    if (!dryRun && prId) {
      try { await github.closePR(config.repo, prId); } catch {}
    }
  } else {
    log.info(`  PR: ${task.pr_url ?? 'none'} — ${task.pr_url ? 'not open' : 'N/A'}`);
  }

  // 6. Labels — remove foundry labels, add ready
  const labelsToRemove = [
    config.labels.in_progress,
    config.labels.waiting_for_input,
    config.labels.failed,
    config.labels.done,
    config.labels.ready_for_review,
  ];
  logAction(dryRun, `Remove labels: ${labelsToRemove.join(', ')}`);
  logAction(dryRun, `Add label: ${config.labels.ready}`);
  if (!dryRun) {
    for (const label of labelsToRemove) {
      try { await github.removeLabel(config.repo, issueNum, label); } catch {}
    }
    try { await github.addLabel(config.repo, issueNum, config.labels.ready); } catch {}
  }

  // 7. State
  logAction(dryRun, 'Remove task from state');
  if (!dryRun) {
    state.removeTask(config.repo, issueNum);
  }

  log.info('');
  if (dryRun) {
    log.info('No changes made. Run with --force to execute.');
  } else {
    log.success(`Reset complete for #${issueNum}. Issue restored to ${config.labels.ready}.`);
  }
}

function logAction(dryRun: boolean, message: string): void {
  const prefix = dryRun ? 'would' : '     ';
  log.info(`  ${prefix}: ${message}`);
}
