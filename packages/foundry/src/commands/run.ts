/**
 * foundry run — main runner loop.
 *
 * Poll → claim → spawn agent sessions (respect max_sessions).
 * Reconcile on startup.
 * Human-in-the-loop: detect agent questions, post to GitHub, resume on reply.
 * PR review feedback: detect change requests, resume agent with feedback.
 */
import * as path from 'node:path';
import { loadConfig, getConfigDir } from '../config.js';
import * as github from '../lib/github.js';
import * as git from '../lib/git.js';
import * as tmux from '../lib/tmux.js';
import * as state from '../lib/state.js';
import * as claim from '../lib/claim.js';
import * as log from '../lib/log.js';
import * as verify from '../lib/verify.js';
import * as agentOutput from '../lib/agent-output.js';
import { resolveBackend, resolveBackendForIssue } from '../backends/index.js';
import type { FoundryConfig, GitHubIssue, TaskState, AgentLaunchParams, AgentOutcome, ResumeParams } from '../types.js';

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

    // Waiting/pr-changes-requested tasks are valid without a tmux session
    if (['waiting-for-input', 'pr-changes-requested'].includes(task.status)) continue;

    // If resuming but tmux is dead, revert to waiting-for-input
    if (task.status === 'resuming' && !tmux.sessionExists(task.tmux_session)) {
      log.warn(`Resume session ${task.tmux_session} for #${task.issue} is dead. Reverting to waiting-for-input.`);
      state.updateTaskStatus(config.repo, task.issue, 'waiting-for-input');
      continue;
    }

    // Check if tmux session is still alive
    if (!tmux.sessionExists(task.tmux_session)) {
      log.warn(`Session ${task.tmux_session} for #${task.issue} is dead. Marking stopped.`);
      state.updateTaskStatus(config.repo, task.issue, 'stopped');
      claim.markFailed(config, task.issue);
      try { github.addComment(config.repo, task.issue, `**Foundry: Session Died**\n\ntmux session \`${task.tmux_session}\` exited unexpectedly during reconciliation.`); } catch {}
    }
  }
}

async function poll(config: FoundryConfig, repoDir: string): Promise<void> {
  // Check for human responses to waiting tasks
  await checkWaitingTasks(config, repoDir);

  // Check for PR review feedback
  await checkPRFeedback(config, repoDir);

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

  // Clean up stale worktree/branch from previous failed attempt
  if (git.worktreeExists(worktree, repoDir)) {
    log.info(`Removing stale worktree from previous attempt: ${worktree}`);
    git.removeWorktree(worktree, repoDir);
  }
  if (git.branchExists(branch, repoDir)) {
    log.info(`Removing stale branch from previous attempt: ${branch}`);
    git.deleteBranch(branch, repoDir);
  }

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

  // Launch agent — `; exit` ensures the shell (and tmux session) closes
  // when the agent finishes, so checkCompletedAgents detects completion.
  tmux.sendKeys(tmuxSession, `${agentCommand}; exit`);

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

// ── Completed Agent Handling ─────────────────────────────────────────────

async function checkCompletedAgents(config: FoundryConfig, repoDir: string): Promise<void> {
  const tasks = state.getAllTasks(config.repo);
  const runningTasks = tasks.filter(t => t.status === 'agent-running' || t.status === 'resuming');

  for (const task of runningTasks) {
    if (!tmux.sessionExists(task.tmux_session)) {
      log.info(`Agent for #${task.issue} has exited. Analyzing outcome...`);

      const logPath = path.join(state.getLogDir(config.repo, task.issue), 'agent.log');
      const baseBranch = git.remoteBranchExists('integration', repoDir)
        ? 'origin/integration'
        : 'origin/main';

      const outcome = agentOutput.determineOutcome(logPath, task.worktree, baseBranch);
      log.info(`Outcome for #${task.issue}: ${outcome.type}`);

      // Persist session_id for future resumes
      if (outcome.session_id) {
        state.updateTaskStatus(config.repo, task.issue, task.status, {
          session_id: outcome.session_id,
        });
      }

      switch (outcome.type) {
        case 'completed':
        case 'indeterminate':
          await handleCompleted(config, task, repoDir);
          break;
        case 'needs-input':
          await handleNeedsInput(config, task, outcome);
          break;
        case 'errored':
          log.error(`Agent for #${task.issue} errored.`);
          state.updateTaskStatus(config.repo, task.issue, 'failed', {
            last_agent_message: outcome.final_message ?? undefined,
          });
          claim.markFailed(config, task.issue);
          if (outcome.final_message) {
            try {
              github.addComment(config.repo, task.issue, [
                '**Foundry Agent Error**',
                '',
                outcome.final_message.slice(-2000),
              ].join('\n'));
            } catch {
              // best effort
            }
          }
          break;
      }
    }
  }
}

async function handleCompleted(config: FoundryConfig, task: TaskState, repoDir: string): Promise<void> {
  log.info(`Running verification for #${task.issue}...`);
  state.updateTaskStatus(config.repo, task.issue, 'verifying');

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
      claim.markFailed(config, task.issue);
      try { github.addComment(config.repo, task.issue, `**Foundry: Push Failed**\n\n${err.message}`); } catch {}
      return;
    }

    // Create or update PR
    if (task.pr_url) {
      // PR already exists (resumed agent pushed updates) — just update status
      log.success(`PR already exists for #${task.issue}: ${task.pr_url}`);
      state.updateTaskStatus(config.repo, task.issue, 'pr-open');
      github.addLabel(config.repo, task.issue, config.labels.ready_for_review);
    } else {
      try {
        const prUrl = github.createPR(config.repo, {
          title: `#${task.issue}: ${task.title}`,
          body: `Closes #${task.issue}\n\nAutomated by Foundry (${task.agent_backend})`,
          head: task.branch,
          base: 'integration',
        });
        log.success(`PR created: ${prUrl}`);
        const prNumber = github.extractPRNumber(prUrl);
        state.updateTaskStatus(config.repo, task.issue, 'pr-open', {
          pr_url: prUrl,
          pr_number: prNumber ?? undefined,
        });
        github.addLabel(config.repo, task.issue, config.labels.done);
        github.addLabel(config.repo, task.issue, config.labels.ready_for_review);
      } catch (err: any) {
        log.error(`PR creation failed for #${task.issue}: ${err.message}`);
        state.updateTaskStatus(config.repo, task.issue, 'failed');
        claim.markFailed(config, task.issue);
        try { github.addComment(config.repo, task.issue, `**Foundry: PR Creation Failed**\n\n${err.message}`); } catch {}
      }
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
    claim.markFailed(config, task.issue);

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

// ── Human-in-the-Loop: Needs Input ───────────────────────────────────────

async function handleNeedsInput(config: FoundryConfig, task: TaskState, outcome: AgentOutcome): Promise<void> {
  const inputRound = (task.input_request_count ?? 0) + 1;

  // Safety valve
  if (inputRound > config.max_input_rounds) {
    log.error(`#${task.issue} exceeded max input rounds (${config.max_input_rounds}). Marking failed.`);
    state.updateTaskStatus(config.repo, task.issue, 'failed', {
      input_request_count: inputRound,
      last_agent_message: outcome.final_message ?? undefined,
    });
    claim.markFailed(config, task.issue);
    try {
      const target = task.pr_url ? 'PR' : 'issue';
      const body = `**Foundry Agent — Giving Up** (exceeded ${config.max_input_rounds} input rounds)\n\nThe agent has been unable to complete this task after multiple rounds of input. Manual intervention required.`;
      postToConversationTarget(config, task, body);
    } catch {
      // best effort
    }
    return;
  }

  log.info(`#${task.issue} needs input (round ${inputRound}).`);

  const comment = agentOutput.formatInputRequestComment(outcome, inputRound);

  try {
    postToConversationTarget(config, task, comment);
  } catch (err: any) {
    log.error(`Failed to post input request for #${task.issue}: ${err.message}`);
  }

  // Add waiting label, update state
  try {
    github.addLabel(config.repo, task.issue, config.labels.waiting_for_input);
  } catch {
    // best effort
  }

  state.updateTaskStatus(config.repo, task.issue, 'waiting-for-input', {
    session_id: outcome.session_id ?? task.session_id,
    input_request_count: inputRound,
    last_agent_message: outcome.final_message ?? undefined,
  });
}

function postToConversationTarget(config: FoundryConfig, task: TaskState, body: string): void {
  if (task.pr_number) {
    github.commentOnPR(config.repo, task.pr_number, body);
  } else if (task.pr_url) {
    const prNumber = github.extractPRNumber(task.pr_url);
    if (prNumber) {
      github.commentOnPR(config.repo, prNumber, body);
    } else {
      github.addComment(config.repo, task.issue, body);
    }
  } else {
    github.addComment(config.repo, task.issue, body);
  }
}

// ── Human-in-the-Loop: Check for Responses ───────────────────────────────

async function checkWaitingTasks(config: FoundryConfig, repoDir: string): Promise<void> {
  const tasks = state.getAllTasks(config.repo);
  const waitingTasks = tasks.filter(t => t.status === 'waiting-for-input');

  for (const task of waitingTasks) {
    if (!running) break;

    try {
      const humanResponse = findHumanResponse(config, task);
      if (humanResponse) {
        log.info(`Human response found for #${task.issue}. Resuming agent...`);
        await resumeAgent(config, task, humanResponse, repoDir);
      }
    } catch (err: any) {
      log.error(`Error checking waiting task #${task.issue}: ${err.message}`);
    }
  }
}

function findHumanResponse(config: FoundryConfig, task: TaskState): string | null {
  // Determine where to look for the response
  const comments = task.pr_number
    ? getPRComments(config.repo, task.pr_number)
    : github.getComments(config.repo, task.issue);

  // Find the last foundry input request marker
  let lastRequestIndex = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes('<!-- foundry-input-request -->')) {
      lastRequestIndex = i;
      break;
    }
  }

  if (lastRequestIndex === -1) return null;

  // Find human replies after the marker (non-bot comments)
  const repliesAfterRequest = comments.slice(lastRequestIndex + 1);
  const humanReplies = repliesAfterRequest.filter(c => {
    const login = c.user?.login ?? '';
    // Filter out bot accounts (common patterns)
    return !login.includes('[bot]') && login !== 'github-actions' && login !== 'foundry';
  });

  if (humanReplies.length === 0) return null;

  // Concatenate all human replies
  return humanReplies.map(c => c.body).join('\n\n');
}

function getPRComments(repo: string, prNumber: number): Array<{ body: string; user: { login: string } | null; created_at: string }> {
  // PR comments come from the issues endpoint (PRs are issues in GitHub)
  return github.getComments(repo, prNumber);
}

async function resumeAgent(config: FoundryConfig, task: TaskState, humanResponse: string, repoDir: string): Promise<void> {
  // Remove waiting label
  try {
    github.removeLabel(config.repo, task.issue, config.labels.waiting_for_input);
  } catch {
    // best effort
  }

  // Kill old tmux session if somehow still alive
  tmux.killSession(task.tmux_session);

  const backend = resolveBackend(config, task.agent_backend);
  const logDir = state.getLogDir(config.repo, task.issue);
  const stateDir = state.getTaskStateDir(config.repo, task.issue);

  const launchParams: AgentLaunchParams = {
    worktree: task.worktree,
    issue_url: `https://github.com/${task.repo}/issues/${task.issue}`,
    issue_number: task.issue,
    repo: task.repo,
    title: task.title,
    body: humanResponse,
    labels: [],
    log_dir: logDir,
    state_dir: stateDir,
  };

  let command: string;

  if (task.session_id) {
    const resumeParams: ResumeParams = {
      ...launchParams,
      session_id: task.session_id,
      prompt: humanResponse.replace(/'/g, "'\\''"),
    };
    const resumeCmd = backend.resolveResumeCommand(resumeParams);
    if (resumeCmd) {
      command = resumeCmd;
    } else {
      // Backend doesn't support resume — re-launch with feedback in prompt
      log.warn(`Backend "${backend.name}" has no resume_command. Re-launching with feedback.`);
      command = backend.resolveCommand(launchParams);
    }
  } else {
    // No session_id — re-launch with feedback in prompt
    log.warn(`No session_id for #${task.issue}. Re-launching agent with feedback.`);
    command = backend.resolveCommand(launchParams);
  }

  // Create new tmux session in the existing worktree
  tmux.createSession(task.tmux_session, task.worktree);
  tmux.sendKeys(task.tmux_session, `${command}; exit`);

  state.updateTaskStatus(config.repo, task.issue, 'agent-running');
  log.success(`Resumed agent for #${task.issue} in ${task.tmux_session}`);
}

// ── PR Review Feedback Loop ──────────────────────────────────────────────

async function checkPRFeedback(config: FoundryConfig, repoDir: string): Promise<void> {
  const tasks = state.getAllTasks(config.repo);
  const prOpenTasks = tasks.filter(t => t.status === 'pr-open');

  for (const task of prOpenTasks) {
    if (!running) break;

    const prNumber = task.pr_number ?? (task.pr_url ? github.extractPRNumber(task.pr_url) : null);
    if (!prNumber) continue;

    // Persist pr_number if we just extracted it
    if (!task.pr_number) {
      state.updateTaskStatus(config.repo, task.issue, task.status, { pr_number: prNumber });
    }

    try {
      const feedback = findPRFeedback(config, prNumber, task);
      if (feedback) {
        log.info(`PR review feedback found for #${task.issue}. Resuming agent...`);
        state.updateTaskStatus(config.repo, task.issue, 'pr-changes-requested', {
          last_agent_message: feedback,
        });
        await resumeAgentForPR(config, task, feedback, repoDir);
      }
    } catch (err: any) {
      log.error(`Error checking PR feedback for #${task.issue}: ${err.message}`);
    }
  }
}

function findPRFeedback(config: FoundryConfig, prNumber: number, task: TaskState): string | null {
  const { reviews, comments } = github.getPRReviews(config.repo, prNumber);

  // Look for CHANGES_REQUESTED reviews or new review comments since last update
  const taskUpdated = new Date(task.updated_at).getTime();

  const newChangeRequests = reviews.filter(r =>
    r.state === 'CHANGES_REQUESTED' &&
    new Date(r.submittedAt).getTime() > taskUpdated
  );

  const newReviewComments = comments.filter(c =>
    new Date(c.createdAt).getTime() > taskUpdated
  );

  if (newChangeRequests.length === 0 && newReviewComments.length === 0) return null;

  // Build feedback context for the agent
  const parts: string[] = ['PR review feedback for your changes:'];

  for (const review of newChangeRequests) {
    parts.push(`\n**Review by ${review.author.login} (changes requested):**`);
    if (review.body) parts.push(review.body);
  }

  for (const comment of newReviewComments) {
    const location = comment.path ? ` on \`${comment.path}${comment.line ? `:${comment.line}` : ''}\`` : '';
    parts.push(`\n**Comment by ${comment.author.login}${location}:**`);
    parts.push(comment.body);
  }

  parts.push('\nPlease address the review feedback, commit your changes, and push.');

  return parts.join('\n');
}

async function resumeAgentForPR(config: FoundryConfig, task: TaskState, feedback: string, repoDir: string): Promise<void> {
  // Safety valve
  const inputRound = (task.input_request_count ?? 0) + 1;
  if (inputRound > config.max_input_rounds) {
    log.error(`#${task.issue} exceeded max input rounds (${config.max_input_rounds}) for PR feedback. Needs manual intervention.`);
    try {
      github.commentOnPR(config.repo, task.pr_number!, [
        `**Foundry Agent — Giving Up** (exceeded ${config.max_input_rounds} input rounds)`,
        '',
        'The agent has been unable to address review feedback after multiple rounds. Manual intervention required.',
      ].join('\n'));
    } catch {
      // best effort
    }
    state.updateTaskStatus(config.repo, task.issue, 'failed', { input_request_count: inputRound });
    claim.markFailed(config, task.issue);
    return;
  }

  // Kill old tmux session if somehow still alive
  tmux.killSession(task.tmux_session);

  const backend = resolveBackend(config, task.agent_backend);
  const logDir = state.getLogDir(config.repo, task.issue);
  const stateDir = state.getTaskStateDir(config.repo, task.issue);

  const launchParams: AgentLaunchParams = {
    worktree: task.worktree,
    issue_url: `https://github.com/${task.repo}/issues/${task.issue}`,
    issue_number: task.issue,
    repo: task.repo,
    title: task.title,
    body: feedback,
    labels: [],
    log_dir: logDir,
    state_dir: stateDir,
  };

  let command: string;

  if (task.session_id) {
    const resumeParams: ResumeParams = {
      ...launchParams,
      session_id: task.session_id,
      prompt: feedback.replace(/'/g, "'\\''"),
    };
    const resumeCmd = backend.resolveResumeCommand(resumeParams);
    if (resumeCmd) {
      command = resumeCmd;
    } else {
      log.warn(`Backend "${backend.name}" has no resume_command. Re-launching with feedback.`);
      command = backend.resolveCommand(launchParams);
    }
  } else {
    log.warn(`No session_id for #${task.issue}. Re-launching agent with PR feedback.`);
    command = backend.resolveCommand(launchParams);
  }

  // Create new tmux session in the existing worktree
  tmux.createSession(task.tmux_session, task.worktree);
  tmux.sendKeys(task.tmux_session, `${command}; exit`);

  state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
    input_request_count: inputRound,
  });
  log.success(`Resumed agent for #${task.issue} to address PR feedback (round ${inputRound})`);
}

// ── Utility ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
