/**
 * EventHandler — processes FoundryEvent instances.
 *
 * All handler logic that was previously inline in run.ts lives here.
 * run.ts becomes a thin composition layer that wires Poller → EventHandler.
 */
import * as github from './github.js';
import * as git from './git.js';
import { resolveWorker } from './workers/index.js';
import type { Worker } from './worker.js';
import * as state from './state.js';
import * as claim from './claim.js';
import * as log from './log.js';
import * as verify from './verify.js';
import * as agentOutput from './agent-output.js';
import { resolveBackend, resolveBackendForIssue } from '../backends/index.js';
import * as preview from './preview.js';
import * as statusComment from './status-comment.js';
import type { FoundryConfig, TaskState, AgentLaunchParams, AgentOutcome, ResumeParams } from '../types.js';
import type {
  FoundryEvent,
  CommandEvent,
  IssueReadyEvent,
  IssueClaimEvent,
  PRMergedEvent,
  PRReviewEvent,
  AgentCompletedEvent,
  HumanResponseEvent,
  PlanApprovedEvent,
} from './events.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function resolvePermissionMode(issueLabels: string[], config: FoundryConfig): string {
  const modeLabels = config.mode_labels ?? { plan: 'mode:plan', auto: 'mode:auto', default: 'mode:default' };

  if (issueLabels.includes(modeLabels.plan)) return '--permission-mode plan';
  if (issueLabels.includes(modeLabels.default)) return '--permission-mode default';
  return '--dangerously-skip-permissions';
}

function getWorker(config: FoundryConfig): Worker {
  return resolveWorker(config.worker?.type);
}

async function postToConversationTarget(config: FoundryConfig, task: TaskState, body: string): Promise<void> {
  if (task.pr_number) {
    await github.commentOnPR(config.repo, task.pr_number, body);
  } else if (task.pr_url) {
    const prNumber = github.extractPRNumber(task.pr_url);
    if (prNumber) {
      await github.commentOnPR(config.repo, prNumber, body);
    } else {
      await github.addComment(config.repo, task.issue, body);
    }
  } else {
    await github.addComment(config.repo, task.issue, body);
  }
}

async function triggerPreviewUp(config: FoundryConfig, task: TaskState): Promise<void> {
  if (!config.preview) return;
  const fresh = state.getAllTasks(config.repo).find(t => t.issue === task.issue);
  if (fresh) {
    try { await preview.previewUp(config, fresh); } catch (err: any) {
      log.warn(`Preview up failed for #${task.issue}: ${err.message}`);
    }
  }
}

async function triggerPreviewDown(config: FoundryConfig, task: TaskState): Promise<void> {
  if (!config.preview) return;
  if (!task.preview_url) return;
  try { await preview.previewDown(config, task); } catch (err: any) {
    log.warn(`Preview down failed for #${task.issue}: ${err.message}`);
  }
}

// ── EventHandler ─────────────────────────────────────────────────────────

export class EventHandler {
  constructor(
    private config: FoundryConfig,
    private repoDir: string,
  ) {}

  async handleEvent(event: FoundryEvent): Promise<void> {
    switch (event.type) {
      case 'command':
        return this.handleCommand(event);
      case 'issue_ready':
        return this.handleIssueReady(event);
      case 'issue_claim':
        return this.handleIssueClaim(event);
      case 'pr_merged':
        return this.handlePRMerged(event);
      case 'pr_review':
        return this.handlePRReview(event);
      case 'agent_completed':
        return this.handleAgentCompleted(event);
      case 'human_response':
        return this.handleHumanResponse(event);
      case 'plan_approved':
        return this.handlePlanApproved(event);
    }
  }

  // ── Command dispatch ─────────────────────────────────────────────────

  private async handleCommand(event: CommandEvent): Promise<void> {
    switch (event.command) {
      case 'stop':
        return this.handleCommandStop(event.task);
      case 'restart':
        return this.handleCommandRestart(event.task);
      case 'replan':
        return this.handleCommandReplan(event.task);
      case 'continue':
        return this.handleCommandContinue(event.task, event.message ?? '');
      case 'plan':
        return this.handleCommandPlan(event.task, event.message ?? '');
      case 'start':
        return this.handleCommandStart(event.task, event.message ?? '');
    }
  }

  // ── Issue Ready (spawn agent) ────────────────────────────────────────

  private async handleIssueReady(event: IssueReadyEvent): Promise<void> {
    const { issue } = event;
    const config = this.config;
    const repoDir = this.repoDir;

    const runnerId = state.getRunnerId();
    const branch = git.resolveBranchName(config.branch_template, issue.number, issue.title);
    const worktree = git.resolveWorktreePath(config.worktree_base, issue.number, issue.title, repoDir);
    const tmuxSession = git.resolveTmuxName(config.tmux_template, issue.number);
    const issueLabels = issue.labels.map(l => l.name);
    const backend = resolveBackendForIssue(config, issueLabels);

    log.info(`Claiming #${issue.number}: ${issue.title}`);

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

    try { git.fetchAll(repoDir); } catch (err: any) {
      log.warn(`Fetch failed: ${err.message}`);
    }

    const base = git.remoteBranchExists('integration', repoDir)
      ? 'origin/integration'
      : 'origin/main';

    if (git.worktreeExists(worktree, repoDir)) {
      log.info(`Removing stale worktree from previous attempt: ${worktree}`);
      git.removeWorktree(worktree, repoDir);
    }
    if (git.branchExists(branch, repoDir)) {
      log.info(`Removing stale branch from previous attempt: ${branch}`);
      git.deleteBranch(branch, repoDir);
    }
    if (git.remoteBranchExists(branch, repoDir)) {
      log.info(`Removing stale remote branch from previous attempt: ${branch}`);
      git.deleteRemoteBranch(branch, repoDir);
    }

    try {
      git.addWorktree(worktree, branch, base, repoDir);
      log.success(`Worktree: ${worktree}`);
    } catch (err: any) {
      log.error(`Failed to create worktree: ${err.message}`);
      return;
    }

    const logDir = state.getLogDir(config.repo, issue.number);
    const stateDir = state.getTaskStateDir(config.repo, issue.number);
    const permissionMode = resolvePermissionMode(issueLabels, config);

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
      permission_mode: permissionMode,
    };

    const agentCommand = backend.resolveCommand(params);
    const agentEnv = backend.resolveEnv(params);

    const worker = getWorker(config);
    await worker.spawn({
      id: tmuxSession,
      cwd: worktree,
      command: agentCommand,
      env: agentEnv,
    });

    const taskState: TaskState = {
      issue: issue.number,
      title: issue.title,
      repo: config.repo,
      branch,
      worktree,
      tmux_session: tmuxSession,
      agent_backend: backend.name,
      agent_command: agentCommand,
      permission_mode: permissionMode,
      status: 'agent-running',
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      runner_id: runnerId,
    };

    state.upsertTask(config.repo, taskState);

    await statusComment.updateStatusComment(config.repo, issue.number, {
      task: taskState,
      message: 'Agent is working on this issue. `@foundry stop` to cancel.',
      historyEntry: 'Agent started',
    });

    log.success(`Agent launched in ${tmuxSession}`);
  }

  // ── Issue Claim (claim only, no agent) ───────────────────────────────

  private async handleIssueClaim(event: IssueClaimEvent): Promise<void> {
    const { issue } = event;
    const config = this.config;
    const repoDir = this.repoDir;

    const runnerId = state.getRunnerId();
    const branch = git.resolveBranchName(config.branch_template, issue.number, issue.title);
    const worktree = git.resolveWorktreePath(config.worktree_base, issue.number, issue.title, repoDir);
    const tmuxSession = git.resolveTmuxName(config.tmux_template, issue.number);
    const issueLabels = issue.labels.map(l => l.name);
    const backend = resolveBackendForIssue(config, issueLabels);

    log.info(`Claim-only #${issue.number}: ${issue.title}`);

    const claimed = await claim.claimIssueOnly(config, issue, {
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

    log.success(`Claimed #${issue.number} (claim-only)`);

    try { git.fetchAll(repoDir); } catch (err: any) {
      log.warn(`Fetch failed: ${err.message}`);
    }

    const base = git.remoteBranchExists('integration', repoDir)
      ? 'origin/integration'
      : 'origin/main';

    if (git.worktreeExists(worktree, repoDir)) {
      log.info(`Removing stale worktree from previous attempt: ${worktree}`);
      git.removeWorktree(worktree, repoDir);
    }
    if (git.branchExists(branch, repoDir)) {
      log.info(`Removing stale branch from previous attempt: ${branch}`);
      git.deleteBranch(branch, repoDir);
    }
    if (git.remoteBranchExists(branch, repoDir)) {
      log.info(`Removing stale remote branch from previous attempt: ${branch}`);
      git.deleteRemoteBranch(branch, repoDir);
    }

    try {
      git.addWorktree(worktree, branch, base, repoDir);
      log.success(`Worktree: ${worktree}`);
    } catch (err: any) {
      log.error(`Failed to create worktree: ${err.message}`);
      return;
    }

    const taskState: TaskState = {
      issue: issue.number,
      title: issue.title,
      repo: config.repo,
      branch,
      worktree,
      tmux_session: tmuxSession,
      agent_backend: backend.name,
      status: 'claimed',
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      runner_id: runnerId,
    };

    state.upsertTask(config.repo, taskState);
    log.success(`Task #${issue.number} saved as claimed — awaiting commands`);
  }

  // ── PR Merged ────────────────────────────────────────────────────────

  private async handlePRMerged(event: PRMergedEvent): Promise<void> {
    const { task } = event;
    const config = this.config;
    const repoDir = this.repoDir;

    log.success(`PR for #${task.issue} has been merged. Completing task.`);

    await triggerPreviewDown(config, task);

    try { await github.addLabel(config.repo, task.issue, config.labels.done); } catch {}
    try { await github.closeIssue(config.repo, task.issue); } catch {}

    try { git.removeWorktree(task.worktree, repoDir); } catch {}
    try { git.deleteBranch(task.branch, repoDir); } catch {}
    state.removeTask(config.repo, task.issue);

    log.success(`Auto-cleaned resources for #${task.issue}.`);
  }

  // ── PR Review ────────────────────────────────────────────────────────

  private async handlePRReview(event: PRReviewEvent): Promise<void> {
    const { task, feedback } = event;
    const config = this.config;

    log.info(`PR review feedback found for #${task.issue}. Resuming agent...`);
    state.updateTaskStatus(config.repo, task.issue, 'pr-changes-requested', {
      last_agent_message: feedback,
    });
    await this.resumeAgentForPR(task, feedback);
  }

  // ── Agent Completed ──────────────────────────────────────────────────

  private async handleAgentCompleted(event: AgentCompletedEvent): Promise<void> {
    const { task, outcome } = event;
    const config = this.config;

    log.info(`Outcome for #${task.issue}: ${outcome.type}`);

    if (outcome.session_id) {
      state.updateTaskStatus(config.repo, task.issue, task.status, {
        session_id: outcome.session_id,
      });
    }

    switch (outcome.type) {
      case 'completed':
      case 'indeterminate':
        await this.handleCompleted(task);
        break;
      case 'plan-completed':
        await this.handlePlanCompleted(task, outcome);
        break;
      case 'needs-input':
        await this.handleNeedsInput(task, outcome);
        break;
      case 'errored':
        log.error(`Agent for #${task.issue} errored.`);
        state.updateTaskStatus(config.repo, task.issue, 'failed', {
          last_agent_message: outcome.final_message ?? undefined,
        });
        await claim.markFailed(config, task.issue);
        {
          const errorMsg = [
            outcome.final_message ? outcome.final_message.slice(-2000) : 'No error details captured.',
            '',
            '`@foundry restart` to retry from scratch · `@foundry start` to re-queue',
          ].join('\n');
          const freshTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
          await statusComment.updateStatusComment(config.repo, task.issue, {
            task: freshTask,
            message: errorMsg,
            historyEntry: 'Agent errored',
          });
        }
        break;
    }
  }

  // ── Human Response (waiting-for-input) ───────────────────────────────

  private async handleHumanResponse(event: HumanResponseEvent): Promise<void> {
    const { task, response } = event;

    log.info(`Human response found for #${task.issue}. Resuming agent...`);
    await this.resumeAgent(task, response);
  }

  // ── Plan Approved ────────────────────────────────────────────────────

  private async handlePlanApproved(event: PlanApprovedEvent): Promise<void> {
    const { task, response } = event;
    const config = this.config;

    log.info(`Plan approval/feedback for #${task.issue}. Resuming in auto mode...`);

    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.plan_review],
      [config.labels.in_progress],
    );

    await this.resumeAgent(task, response);
  }

  // ── Command handlers ─────────────────────────────────────────────────

  private async handleCommandStop(task: TaskState): Promise<void> {
    const config = this.config;

    if (task.status !== 'claimed') {
      const worker = getWorker(config);
      await worker.handleFor(task.tmux_session).kill();
    }

    await triggerPreviewDown(config, task);

    state.updateTaskStatus(config.repo, task.issue, 'failed');
    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.in_progress, config.labels.waiting_for_input, config.labels.plan_review],
      [config.labels.failed],
    );

    const stoppedTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: stoppedTask,
      message: 'Agent has been stopped per `@foundry stop` command.\n\n`@foundry restart` to retry from scratch · `@foundry start` to re-queue',
      historyEntry: 'Stopped via @foundry stop',
    });

    log.success(`Stopped agent for #${task.issue} via @foundry stop`);
  }

  private async handleCommandRestart(task: TaskState): Promise<void> {
    const config = this.config;
    const repoDir = this.repoDir;

    if (task.status !== 'claimed') {
      const worker = getWorker(config);
      await worker.handleFor(task.tmux_session).kill();
    }

    await triggerPreviewDown(config, task);

    try { git.removeWorktree(task.worktree, repoDir); } catch {}
    try { git.deleteBranch(task.branch, repoDir); } catch {}
    try { git.deleteRemoteBranch(task.branch, repoDir); } catch {}

    state.removeTask(config.repo, task.issue);

    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.in_progress, config.labels.failed, config.labels.waiting_for_input,
       config.labels.plan_review, config.labels.ready_for_review],
      [config.labels.ready],
    );

    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: { ...task, status: 'stopped' },
      message: 'Work discarded per `@foundry restart`. The issue has been re-queued and will be claimed on the next poll cycle.',
      historyEntry: 'Restarted via @foundry restart',
    });

    log.success(`Restarted #${task.issue} via @foundry restart — re-queued as ready`);
  }

  private async handleCommandReplan(task: TaskState): Promise<void> {
    const config = this.config;

    const worker = getWorker(config);
    await worker.handleFor(task.tmux_session).kill();

    const issue = await github.getIssue(config.repo, task.issue);
    const issueLabels = issue.labels.map(l => l.name);

    const backend = resolveBackend(config, task.agent_backend);
    const logDir = state.getLogDir(config.repo, task.issue);
    const stateDir = state.getTaskStateDir(config.repo, task.issue);
    const permissionMode = resolvePermissionMode(issueLabels, config);

    const params: AgentLaunchParams = {
      worktree: task.worktree,
      issue_url: issue.html_url,
      issue_number: issue.number,
      repo: config.repo,
      title: issue.title,
      body: issue.body ?? '',
      labels: issueLabels,
      log_dir: logDir,
      state_dir: stateDir,
      permission_mode: permissionMode,
    };

    const agentCommand = backend.resolveCommand(params);
    const agentEnv = backend.resolveEnv(params);

    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command: agentCommand,
      env: agentEnv,
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      permission_mode: permissionMode,
    });

    const replanTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'agent-running' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: replanTask,
      message: 'Agent re-launched with fresh issue body per `@foundry replan`. `@foundry stop` to cancel.',
      historyEntry: 'Replanned via @foundry replan',
    });

    log.success(`Replanned #${task.issue} via @foundry replan`);
  }

  private async handleCommandContinue(task: TaskState, message: string): Promise<void> {
    const config = this.config;
    const prompt = message || 'The user asked you to continue working on this task.';

    if (task.status === 'claimed') {
      await this.launchAgentFromClaimed(task, message);
    } else if (task.status === 'pr-open') {
      state.updateTaskStatus(config.repo, task.issue, 'pr-changes-requested', {
        last_agent_message: prompt,
      });
      await this.resumeAgentForPR(task, prompt);
    } else {
      await this.resumeAgent(task, prompt);
    }

    const continueTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'agent-running' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: continueTask,
      message: 'Agent is continuing per `@foundry continue`. `@foundry stop` to cancel.',
      historyEntry: 'Resumed via @foundry continue',
    });

    log.success(`Continued #${task.issue} via @foundry continue`);
  }

  private async handleCommandPlan(task: TaskState, message: string): Promise<void> {
    const config = this.config;

    if (task.status !== 'claimed') {
      const worker = getWorker(config);
      await worker.handleFor(task.tmux_session).kill();
    }

    const issue = await github.getIssue(config.repo, task.issue);
    const issueLabels = issue.labels.map(l => l.name);

    const body = message
      ? `${issue.body ?? ''}\n\n---\nAdditional instructions from @foundry plan:\n${message}`
      : issue.body ?? '';

    const backend = resolveBackend(config, task.agent_backend);
    const logDir = state.getLogDir(config.repo, task.issue);
    const stateDir = state.getTaskStateDir(config.repo, task.issue);

    const params: AgentLaunchParams = {
      worktree: task.worktree,
      issue_url: issue.html_url,
      issue_number: issue.number,
      repo: config.repo,
      title: issue.title,
      body,
      labels: issueLabels,
      log_dir: logDir,
      state_dir: stateDir,
      permission_mode: '--permission-mode plan',
    };

    const agentCommand = backend.resolveCommand(params);
    const agentEnv = backend.resolveEnv(params);

    const worker = getWorker(config);
    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command: agentCommand,
      env: agentEnv,
    });

    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.waiting_for_input, config.labels.plan_review],
      [config.labels.in_progress],
    );

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      permission_mode: '--permission-mode plan',
    });

    const planModeTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'agent-running' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: planModeTask,
      message: 'Agent re-launched in plan mode per `@foundry plan`. It will produce a plan for review instead of implementing directly. `@foundry stop` to cancel.',
      historyEntry: 'Switched to plan mode via @foundry plan',
    });

    log.success(`Switched #${task.issue} to plan mode via @foundry plan`);
  }

  private async handleCommandStart(task: TaskState, message: string): Promise<void> {
    const config = this.config;
    const repoDir = this.repoDir;

    await triggerPreviewDown(config, task);

    if (task.status !== 'claimed') {
      const worker = getWorker(config);
      await worker.handleFor(task.tmux_session).kill();
    }
    try { git.removeWorktree(task.worktree, repoDir); } catch {}
    try { git.deleteBranch(task.branch, repoDir); } catch {}
    try { git.deleteRemoteBranch(task.branch, repoDir); } catch {}

    state.removeTask(config.repo, task.issue);

    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.failed, config.labels.in_progress, config.labels.waiting_for_input],
      [config.labels.ready],
    );

    if (message) {
      try {
        await github.addComment(config.repo, task.issue,
          `**Foundry: Starting** — Re-queued per \`@foundry start\`. Additional context from the user:\n\n${message}`);
      } catch {}
    } else {
      try {
        await github.addComment(config.repo, task.issue,
          '**Foundry: Starting** — Re-queued per `@foundry start`. Will be claimed on the next poll cycle.');
      } catch {}
    }

    log.success(`Re-queued #${task.issue} via @foundry start`);
  }

  // ── Completed agent sub-handlers ─────────────────────────────────────

  private async handleCompleted(task: TaskState): Promise<void> {
    const config = this.config;
    const repoDir = this.repoDir;

    log.info(`Running verification for #${task.issue}...`);
    state.updateTaskStatus(config.repo, task.issue, 'verifying');

    const headSha = git.headSha(task.worktree);
    let checkRunId: number | undefined;
    try {
      checkRunId = await github.createCheckRun(config.repo, {
        name: 'Foundry Verification',
        head_sha: headSha,
        status: 'in_progress',
        output: {
          title: 'Verification in progress',
          summary: `Running verification for #${task.issue}...`,
        },
      });
    } catch (err: any) {
      log.warn(`Failed to create check run for #${task.issue}: ${err.message}`);
    }

    const result = verify.runVerifyPipeline(config, task.worktree);

    const stepSummary = result.results.map(r =>
      `- \`${r.command}\`: ${r.success ? 'passed' : 'FAILED'} (${r.duration_ms}ms)`
    ).join('\n');

    if (result.passed) {
      log.success(`Verification passed for #${task.issue}.`);

      if (checkRunId) {
        try {
          await github.updateCheckRun(config.repo, checkRunId, {
            status: 'completed',
            conclusion: 'success',
            output: {
              title: 'Verification passed',
              summary: stepSummary,
            },
          });
        } catch (err: any) {
          log.warn(`Failed to update check run for #${task.issue}: ${err.message}`);
        }
      }

      try {
        git.push(task.branch, task.worktree);
        log.success(`Pushed ${task.branch}`);
      } catch (err: any) {
        log.error(`Push failed for #${task.issue}: ${err.message}`);
        state.updateTaskStatus(config.repo, task.issue, 'failed');
        await claim.markFailed(config, task.issue);
        const pushFailedTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
        await statusComment.updateStatusComment(config.repo, task.issue, {
          task: pushFailedTask,
          message: `Push failed:\n\n${err.message}`,
          historyEntry: 'Push failed',
        });
        return;
      }

      if (task.pr_url) {
        log.success(`PR already exists for #${task.issue}: ${task.pr_url}`);
        state.updateTaskStatus(config.repo, task.issue, 'pr-open');
        await github.transitionLabels(
          config.repo, task.issue,
          [config.labels.in_progress],
          [config.labels.ready_for_review],
        );
        await triggerPreviewUp(config, task);
        const prOpenTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'pr-open' as const };
        await statusComment.updateStatusComment(config.repo, task.issue, {
          task: prOpenTask,
          message: 'Verification passed. PR updated with new changes.\n\nFoundry is watching this PR. Submit a review with **Request changes** or comment `@foundry continue [feedback]`.',
          historyEntry: 'Verification passed, PR updated',
        });
      } else {
        try {
          const prUrl = await github.createPR(config.repo, {
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
          await github.transitionLabels(
            config.repo, task.issue,
            [config.labels.in_progress],
            [config.labels.ready_for_review],
          );
          await triggerPreviewUp(config, task);
          const newPrTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'pr-open' as const };
          await statusComment.updateStatusComment(config.repo, task.issue, {
            task: newPrTask,
            prUrl,
            message: 'Verification passed. PR created and ready for review.\n\nFoundry is watching this PR. Submit a review with **Request changes** or comment `@foundry continue [feedback]`.',
            historyEntry: 'Verification passed, PR created',
          });
        } catch (err: any) {
          log.error(`PR creation failed for #${task.issue}: ${err.message}`);
          state.updateTaskStatus(config.repo, task.issue, 'failed');
          await claim.markFailed(config, task.issue);
          const prFailTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
          await statusComment.updateStatusComment(config.repo, task.issue, {
            task: prFailTask,
            message: `PR creation failed:\n\n${err.message}`,
            historyEntry: 'PR creation failed',
          });
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

      if (checkRunId) {
        try {
          const annotations = verify.parseAnnotations(result.results);
          await github.updateCheckRun(config.repo, checkRunId, {
            status: 'completed',
            conclusion: 'failure',
            output: {
              title: 'Verification failed',
              summary: stepSummary,
              annotations: annotations.length > 0 ? annotations : undefined,
            },
          });
        } catch (err: any) {
          log.warn(`Failed to update check run for #${task.issue}: ${err.message}`);
        }
      }

      state.updateTaskStatus(config.repo, task.issue, 'failed');
      await claim.markFailed(config, task.issue);

      const failureMsg = [
        ...result.results.map(r =>
          `- \`${r.command}\`: ${r.success ? 'passed' : 'FAILED'} (${r.duration_ms}ms)`
        ),
        '',
        result.results
          .filter(r => !r.success)
          .map(r => `\`\`\`\n${r.output.slice(-1000)}\n\`\`\``)
          .join('\n'),
        '',
        '`@foundry restart` to retry from scratch · `@foundry start` to re-queue',
      ].join('\n');

      const verifyFailTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
      await statusComment.updateStatusComment(config.repo, task.issue, {
        task: verifyFailTask,
        message: failureMsg,
        historyEntry: 'Verification failed',
      });
    }
  }

  private async handleNeedsInput(task: TaskState, outcome: AgentOutcome): Promise<void> {
    const config = this.config;
    const inputRound = (task.input_request_count ?? 0) + 1;

    if (inputRound > config.max_input_rounds) {
      log.error(`#${task.issue} exceeded max input rounds (${config.max_input_rounds}). Marking failed.`);
      state.updateTaskStatus(config.repo, task.issue, 'failed', {
        input_request_count: inputRound,
        last_agent_message: outcome.final_message ?? undefined,
      });
      await claim.markFailed(config, task.issue);
      const giveUpTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
      await statusComment.updateStatusComment(config.repo, task.issue, {
        task: giveUpTask,
        message: `Exceeded ${config.max_input_rounds} input rounds. The agent has been unable to complete this task. Manual intervention required.`,
        historyEntry: `Gave up after ${config.max_input_rounds} input rounds`,
      });
      return;
    }

    log.info(`#${task.issue} needs input (round ${inputRound}).`);

    try {
      await github.addLabel(config.repo, task.issue, config.labels.waiting_for_input);
    } catch {}

    state.updateTaskStatus(config.repo, task.issue, 'waiting-for-input', {
      session_id: outcome.session_id ?? task.session_id,
      input_request_count: inputRound,
      last_agent_message: outcome.final_message ?? undefined,
    });

    const inputComment = agentOutput.formatInputRequestComment(outcome, inputRound);
    const inputMsg = inputComment.replace('<!-- foundry-input-request -->\n', '');

    const waitingTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'waiting-for-input' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: waitingTask,
      message: inputMsg,
      historyEntry: `Input needed (round ${inputRound})`,
    });
  }

  private async handlePlanCompleted(task: TaskState, outcome: AgentOutcome): Promise<void> {
    const config = this.config;

    // Post the plan-review comment separately — it has its own marker used for detecting responses
    const planComment = [
      '<!-- foundry-plan-review -->',
      '**Foundry Agent — Plan for Review**',
      '',
      outcome.final_message ?? 'No plan content captured.',
      '',
      '---',
      'Reply to approve this plan, or provide feedback to revise it.',
      '',
      'Or: `@foundry restart` · `@foundry stop`',
    ].join('\n');

    await postToConversationTarget(config, task, planComment);

    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.in_progress],
      [config.labels.plan_review],
    );

    state.updateTaskStatus(config.repo, task.issue, 'plan-review', {
      session_id: outcome.session_id ?? task.session_id,
      last_agent_message: outcome.final_message ?? undefined,
    });

    const planTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'plan-review' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: planTask,
      message: 'Plan ready for review. Reply to the plan comment above to approve or provide feedback.',
      historyEntry: 'Plan completed, awaiting review',
    });

    log.success(`Plan posted for #${task.issue}. Awaiting human review.`);
  }

  // ── Shared resume helpers ────────────────────────────────────────────

  private async launchAgentFromClaimed(task: TaskState, message: string): Promise<void> {
    const config = this.config;

    const issue = await github.getIssue(config.repo, task.issue);
    const issueLabels = issue.labels.map(l => l.name);

    const backend = resolveBackend(config, task.agent_backend);
    const logDir = state.getLogDir(config.repo, task.issue);
    const stateDir = state.getTaskStateDir(config.repo, task.issue);
    const permissionMode = resolvePermissionMode(issueLabels, config);

    const body = message
      ? `${issue.body ?? ''}\n\n---\nAdditional instructions:\n${message}`
      : issue.body ?? '';

    const params: AgentLaunchParams = {
      worktree: task.worktree,
      issue_url: issue.html_url,
      issue_number: issue.number,
      repo: config.repo,
      title: issue.title,
      body,
      labels: issueLabels,
      log_dir: logDir,
      state_dir: stateDir,
      permission_mode: permissionMode,
    };

    const agentCommand = backend.resolveCommand(params);
    const agentEnv = backend.resolveEnv(params);

    const worker = getWorker(config);
    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command: agentCommand,
      env: agentEnv,
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      agent_command: agentCommand,
      permission_mode: permissionMode,
    });
    log.success(`Agent launched from claimed state for #${task.issue} in ${task.tmux_session}`);
  }

  private async resumeAgent(task: TaskState, humanResponse: string): Promise<void> {
    const config = this.config;

    await github.transitionLabels(
      config.repo, task.issue,
      [config.labels.waiting_for_input],
      [],
    );

    const worker = getWorker(config);
    await worker.handleFor(task.tmux_session).kill();

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
      permission_mode: '--dangerously-skip-permissions',
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
        log.warn(`Backend "${backend.name}" has no resume_command. Re-launching with feedback.`);
        command = backend.resolveCommand(launchParams);
      }
    } else {
      log.warn(`No session_id for #${task.issue}. Re-launching agent with feedback.`);
      command = backend.resolveCommand(launchParams);
    }

    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command,
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      permission_mode: '--dangerously-skip-permissions',
    });
    log.success(`Resumed agent for #${task.issue} in ${task.tmux_session}`);
  }

  private async resumeAgentForPR(task: TaskState, feedback: string): Promise<void> {
    const config = this.config;

    const inputRound = (task.input_request_count ?? 0) + 1;
    if (inputRound > config.max_input_rounds) {
      log.error(`#${task.issue} exceeded max input rounds (${config.max_input_rounds}) for PR feedback. Needs manual intervention.`);
      state.updateTaskStatus(config.repo, task.issue, 'failed', { input_request_count: inputRound });
      await claim.markFailed(config, task.issue);
      const prGiveUpTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
      await statusComment.updateStatusComment(config.repo, task.issue, {
        task: prGiveUpTask,
        message: `Exceeded ${config.max_input_rounds} input rounds for PR feedback. Manual intervention required.`,
        historyEntry: `Gave up after ${config.max_input_rounds} PR feedback rounds`,
      });
      return;
    }

    const worker = getWorker(config);
    await worker.handleFor(task.tmux_session).kill();

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
      permission_mode: '--dangerously-skip-permissions',
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

    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command,
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      input_request_count: inputRound,
      permission_mode: '--dangerously-skip-permissions',
    });

    const prFeedbackTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'agent-running' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: prFeedbackTask,
      message: `Agent is addressing PR review feedback (round ${inputRound}). \`@foundry stop\` to cancel.`,
      historyEntry: `Resumed for PR feedback (round ${inputRound})`,
    });

    log.success(`Resumed agent for #${task.issue} to address PR feedback (round ${inputRound})`);
  }
}
