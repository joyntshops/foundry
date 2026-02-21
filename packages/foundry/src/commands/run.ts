/**
 * foundry run — main runner loop.
 *
 * Poll → claim → spawn agent sessions (respect max_sessions).
 * Reconcile on startup.
 */
import { loadConfig, getConfigDir } from '../config.js';
import * as github from '../lib/github.js';
import * as git from '../lib/git.js';
import * as tmux from '../lib/tmux.js';
import * as state from '../lib/state.js';
import * as claim from '../lib/claim.js';
import * as log from '../lib/log.js';
import * as verify from '../lib/verify.js';
import { resolveBackendForIssue } from '../backends/index.js';
import type { FoundryConfig, GitHubIssue, TaskState, AgentLaunchParams } from '../types.js';

let running = true;

export async function runRunner(opts: { once?: boolean }): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();
  const runnerId = state.getRunnerId();

  log.info(`Foundry runner starting — ${runnerId}`);
  log.info(`Repo: ${config.repo}`);
  log.info(`Max sessions: ${config.max_sessions}`);
  log.info(`Polling interval: ${config.poll_interval_seconds}s`);
  log.info('');

  // Graceful shutdown
  process.on('SIGINT', () => {
    log.warn('Shutting down (SIGINT)...');
    running = false;
  });
  process.on('SIGTERM', () => {
    log.warn('Shutting down (SIGTERM)...');
    running = false;
  });

  // Reconcile on startup
  reconcile(config);

  // Main loop
  while (running) {
    try {
      await poll(config, repoDir);
    } catch (err: any) {
      log.error(`Poll error: ${err.message}`);
    }

    if (opts.once) break;

    // Wait for next poll
    await sleep(config.poll_interval_seconds * 1000);
  }

  log.info('Runner stopped.');
}

function reconcile(config: FoundryConfig): void {
  log.info('Reconciling state...');
  const tasks = state.getAllTasks(config.repo);

  for (const task of tasks) {
    if (['done', 'failed', 'stopped'].includes(task.status)) continue;

    // Check if tmux session is still alive
    if (!tmux.sessionExists(task.tmux_session)) {
      log.warn(`Session ${task.tmux_session} for #${task.issue} is dead. Marking stopped.`);
      state.updateTaskStatus(config.repo, task.issue, 'stopped');
    }
  }
}

async function poll(config: FoundryConfig, repoDir: string): Promise<void> {
  const activeCount = state.getActiveTaskCount(config.repo);
  if (activeCount >= config.max_sessions) {
    log.debug(`At capacity: ${activeCount}/${config.max_sessions} sessions.`);
    // Check for completed agents
    await checkCompletedAgents(config, repoDir);
    return;
  }

  log.debug('Polling for ready issues...');
  const issues = github.listIssuesByLabel(config.repo, config.labels.ready);

  if (issues.length === 0) {
    log.debug('No ready issues found.');
    // Still check for completed agents
    await checkCompletedAgents(config, repoDir);
    return;
  }

  log.info(`Found ${issues.length} ready issue(s).`);

  for (const issue of issues) {
    if (!running) break;
    if (state.getActiveTaskCount(config.repo) >= config.max_sessions) break;
    if (claim.isClaimedByUs(config, issue.number)) continue;

    await spawnTask(config, issue, repoDir);
  }

  await checkCompletedAgents(config, repoDir);
}

async function spawnTask(config: FoundryConfig, issue: GitHubIssue, repoDir: string): Promise<void> {
  const runnerId = state.getRunnerId();
  const branch = git.resolveBranchName(config.branch_template, issue.number, issue.title);
  const worktree = git.resolveWorktreePath(config.worktree_base, issue.number, issue.title, repoDir);
  const tmuxSession = git.resolveTmuxName(config.tmux_template, issue.number);
  const issueLabels = issue.labels.map(l => l.name);
  const backend = resolveBackendForIssue(config, issueLabels);

  log.info(`Claiming #${issue.number}: ${issue.title}`);

  // Attempt claim
  const claimed = await claim.claimIssue(config, issue, {
    runner_id: runnerId,
    branch,
    worktree,
    tmux_session: tmuxSession,
    agent_backend: backend.name,
  });

  if (!claimed) {
    log.warn(`Failed to claim #${issue.number} — another runner may own it.`);
    return;
  }

  log.success(`Claimed #${issue.number}`);

  // Fetch latest from remote
  try {
    git.fetchAll(repoDir);
  } catch (err: any) {
    log.warn(`Fetch failed: ${err.message}`);
  }

  // Create worktree + branch
  const base = git.remoteBranchExists('integration', repoDir)
    ? 'origin/integration'
    : 'origin/main';

  try {
    git.addWorktree(worktree, branch, base, repoDir);
    log.success(`Worktree: ${worktree}`);
  } catch (err: any) {
    log.error(`Failed to create worktree: ${err.message}`);
    return;
  }

  // Prepare agent launch params
  const logDir = state.getLogDir(config.repo, issue.number);
  const stateDir = state.getTaskStateDir(config.repo, issue.number);

  const params: AgentLaunchParams = {
    worktree,
    issue_url: issue.html_url,
    issue_number: issue.number,
    repo: config.repo,
    title: issue.title,
    body: issue.body ?? '',
    labels: issueLabels,
    log_dir: logDir,
    state_dir: stateDir,
  };

  const agentCommand = backend.resolveCommand(params);
  const agentEnv = backend.resolveEnv(params);

  // Create tmux session in worktree
  tmux.createSession(tmuxSession, worktree);

  // Set env vars in tmux session
  for (const [k, v] of Object.entries(agentEnv)) {
    tmux.sendKeys(tmuxSession, `export ${k}="${v}"`);
  }

  // Launch agent
  tmux.sendKeys(tmuxSession, agentCommand);

  // Save state
  const taskState: TaskState = {
    issue: issue.number,
    title: issue.title,
    repo: config.repo,
    branch,
    worktree,
    tmux_session: tmuxSession,
    agent_backend: backend.name,
    agent_command: agentCommand,
    status: 'agent-running',
    claimed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    runner_id: runnerId,
  };

  state.upsertTask(config.repo, taskState);
  log.success(`Agent launched in ${tmuxSession}`);
}

async function checkCompletedAgents(config: FoundryConfig, repoDir: string): Promise<void> {
  const tasks = state.getAllTasks(config.repo);
  const runningTasks = tasks.filter(t => t.status === 'agent-running');

  for (const task of runningTasks) {
    if (!tmux.sessionExists(task.tmux_session)) {
      log.info(`Agent for #${task.issue} has exited. Running verification...`);
      state.updateTaskStatus(config.repo, task.issue, 'verifying');

      // Run verification
      const result = verify.runVerifyPipeline(config, task.worktree);

      if (result.passed) {
        log.success(`Verification passed for #${task.issue}.`);

        // Push branch
        try {
          git.push(task.branch, task.worktree);
          log.success(`Pushed ${task.branch}`);
        } catch (err: any) {
          log.error(`Push failed for #${task.issue}: ${err.message}`);
          state.updateTaskStatus(config.repo, task.issue, 'failed');
          continue;
        }

        // Create PR
        try {
          const prUrl = github.createPR(config.repo, {
            title: `#${task.issue}: ${task.title}`,
            body: `Closes #${task.issue}\n\nAutomated by Foundry (${task.agent_backend})`,
            head: task.branch,
            base: 'integration',
          });
          log.success(`PR created: ${prUrl}`);
          state.updateTaskStatus(config.repo, task.issue, 'pr-open', { pr_url: prUrl });
          github.addLabel(config.repo, task.issue, config.labels.done);
        } catch (err: any) {
          log.error(`PR creation failed for #${task.issue}: ${err.message}`);
          state.updateTaskStatus(config.repo, task.issue, 'failed');
        }
      } else {
        log.error(`Verification failed for #${task.issue}.`);
        for (const r of result.results) {
          if (!r.success) {
            log.error(`  Failed: ${r.command}`);
            log.error(`  ${r.output.slice(-500)}`);
          }
        }
        state.updateTaskStatus(config.repo, task.issue, 'failed');

        // Comment on issue with failure details
        const failureComment = [
          '**Foundry Verification Failed**',
          '',
          ...result.results.map(r =>
            `- \`${r.command}\`: ${r.success ? 'passed' : 'FAILED'} (${r.duration_ms}ms)`
          ),
          '',
          result.results
            .filter(r => !r.success)
            .map(r => `\`\`\`\n${r.output.slice(-1000)}\n\`\`\``)
            .join('\n'),
        ].join('\n');

        try {
          github.addComment(config.repo, task.issue, failureComment);
        } catch {
          // best effort
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
