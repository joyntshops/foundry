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
import { setStateLabel } from './labels.js';
import * as log from './log.js';
import * as verify from './verify.js';
import * as agentOutput from './agent-output.js';
import { prepareLaunch } from './agent-report.js';
import { preserveWork, ensureWorktree } from './worktree.js';
import { writeIssueFile } from './issue-file.js';
import * as previewVerify from './preview-verify.js';
import * as path from 'node:path';
import * as stalePRs from './stale-prs.js';
import * as review from './review.js';
import { resolveBackend, resolveBackendForIssue } from '../backends/index.js';
import * as preview from './preview.js';
import * as statusComment from './status-comment.js';
import type { FoundryConfig, TaskState, AgentLaunchParams, AgentOutcome } from '../types.js';
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
  PRPreviewEvent,
  PRApprovedEvent,
} from './events.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const PREVIEW_VERIFY_MARKER = '<!-- foundry-preview-verify -->';

/**
 * What a relaunched agent is told about why it is being launched again. Goes
 * in FOUNDRY_RESUME_CONTEXT; the Claude preset's prompt includes it.
 */
export function buildResumeContext(task: TaskState, humanText: string, kind: 'answer' | 'plan' | 'review'): string {
  const intro = {
    answer: `You stopped earlier because you needed a decision from a human${task.last_agent_message ? `; you reported: "${task.last_agent_message}"` : ' (your questions are in your last status comment on the issue)'}. The human replied:`,
    plan: `You posted a plan for this issue and the human reviewed it. Their reply:`,
    review: `A reviewer requested changes on your pull request:`,
  }[kind];
  const outro = {
    answer: 'Apply the reply and continue the task.',
    plan: 'If the reply approves the plan, implement it now; if it asks for changes, revise the plan and report plan_ready again.',
    review: 'Address the review on this branch and commit.',
  }[kind];
  return [
    `RESUMING issue #${task.issue} on branch ${task.branch}. The branch already holds your earlier commits; continue from its current state, do not start over.`,
    '',
    intro,
    '',
    humanText.trim(),
    '',
    outro,
  ].join('\n');
}

/** The PR description: what the agent says it did and what it assumed, for the reviewer. */
export function buildPRBody(task: TaskState, outcome?: AgentOutcome): string {
  const parts: string[] = [`Closes #${task.issue}`, ''];
  const report = outcome?.report;
  if (report) {
    parts.push('## Summary', '', report.summary, '');
    if (report.assumptions && report.assumptions.length > 0) {
      parts.push('## Assumptions', '', ...report.assumptions.map(a => `- ${a}`), '');
    }
  }
  parts.push('---', `Opened by Foundry (${task.agent_backend}). Request changes on this PR, or comment \`@foundry continue <feedback>\` on the issue, to send the agent back to work.`);
  return parts.join('\n');
}

function resolvePermissionMode(issueLabels: string[], config: FoundryConfig): string {
  const modeLabels = config.mode_labels ?? { plan: 'mode:plan', auto: 'mode:auto', default: 'mode:default' };

  if (issueLabels.includes(modeLabels.plan)) return '--permission-mode plan';
  if (issueLabels.includes(modeLabels.default)) return '--permission-mode default';
  return '--dangerously-skip-permissions';
}

function getWorker(_config: FoundryConfig): Worker {
  return resolveWorker('subprocess');
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

  /**
   * Environment for an agent launch: the backend's own env plus the report
   * contract (schema + report file), with any previous launch's report cleared.
   */
  private launchEnv(
    brief: { issue: number; title: string; body: string },
    backendEnv: Record<string, string> = {},
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const stateDir = state.getTaskStateDir(this.config.repo, brief.issue);
    const issueFile = writeIssueFile(stateDir, {
      number: brief.issue,
      title: brief.title,
      body: brief.body,
      url: `https://github.com/${this.config.repo}/issues/${brief.issue}`,
    });
    return {
      ...backendEnv,
      ...extra,
      ...issueFile,
      FOUNDRY_MAX_TURNS: String(this.config.agent_max_turns ?? 150),
      ...prepareLaunch(stateDir),
    };
  }

  private briefFor(task: TaskState): { issue: number; title: string; body: string } {
    return { issue: task.issue, title: task.title, body: task.issue_body ?? '' };
  }

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
      case 'pr_preview':
        return this.handlePRPreview(event);
      case 'pr_approved':
        return this.handlePRApproved(event);
    }
  }

  // ── Approval → rebase, checks, merge ──────────────────────────────────

  private async handlePRApproved(event: PRApprovedEvent): Promise<void> {
    const config = this.config;
    const label = `PR #${event.pr_number} (${event.branch} → ${event.base})`;
    log.info(`${label} approved by ${event.reviewer}. Reviewing...`);

    const outcome = await review.reviewAndMerge(config, this.repoDir, {
      pr_number: event.pr_number, branch: event.branch, base: event.base, reviewer: event.reviewer,
    });

    if (!outcome.merged) {
      log.warn(`${label} not merged: ${outcome.reason} (${outcome.detail}).`);
      // A conflict is work for the agent, when there is one.
      if ((outcome.reason === 'conflicting' || outcome.reason === 'rebase_failed') && event.task) {
        const instruction = stalePRs.conflictInstruction(event.base, 0).replace(' (PR #0 merged)', '');
        const dispatched = stalePRs.dispatchCommand(event.task.issue, 'continue', instruction);
        const note = dispatched
          ? `PR #${event.pr_number} was approved but conflicts with \`${event.base}\`. Foundry has sent the agent to rebase and resolve; approve again once it is clean.`
          : `PR #${event.pr_number} was approved but conflicts with \`${event.base}\`. Reply with \`@foundry continue\` and:\n\n> ${instruction}`;
        try { await github.addComment(config.repo, event.task.issue, note); } catch {}
      }
      return;
    }

    // Merged in this job: the pull_request.closed event may never arrive
    // (GITHUB_TOKEN), so complete the lifecycle here. Both paths are
    // idempotent if it does arrive.
    if (event.task) {
      await this.handlePRMerged({ type: 'pr_merged', task: event.task, base: event.base });
    } else {
      await this.handlePRPreview({ type: 'pr_preview', action: 'down', pr_number: event.pr_number, branch: event.branch, base: event.base, sha: outcome.sha });
      await stalePRs.handleStalePRs(config, event.base, event.pr_number);
    }
  }

  // ── Previews for pull requests that are not tasks ─────────────────────

  private async handlePRPreview(event: PRPreviewEvent): Promise<void> {
    const config = this.config;
    const label = `PR #${event.pr_number} (${event.branch} → ${event.base})`;

    if (event.action === 'up') {
      log.info(`Preview up for ${label}`);
      try {
        const result = await preview.previewUpTarget(config, {
          branch: event.branch,
          pr_number: event.pr_number,
          sha: event.sha,
        });
        if (!result) {
          log.warn(`No preview URL resolved for ${label}.`);
          return;
        }
        if (previewVerify.isConfigured(config)) {
          await this.verifyPullRequestPreview(event, result.url);
        }
      } catch (err: any) {
        log.warn(`Preview up failed for ${label}: ${err.message}`);
      }
      return;
    }

    const url = await preview.findPreviewUrlOnPR(config.repo, event.pr_number);
    if (!url) {
      log.info(`No preview recorded on ${label}; nothing to tear down.`);
      return;
    }
    log.info(`Preview down for ${label}`);
    try {
      await preview.previewDownTarget(config, {
        branch: event.branch,
        pr_number: event.pr_number,
        sha: event.sha,
        preview_url: url,
      });
    } catch (err: any) {
      log.warn(`Preview down failed for ${label}: ${err.message}`);
    }
  }

  /**
   * Run `verify_preview` for a non-task PR from a throwaway checkout of its
   * head branch. The result goes on the PR as a comment and, when the token
   * allows, as a check run on the head SHA.
   */
  private async verifyPullRequestPreview(event: PRPreviewEvent, url: string): Promise<void> {
    const config = this.config;
    const label = `PR #${event.pr_number}`;
    const cwd = path.resolve(this.repoDir, config.worktree_base, `pr-${event.pr_number}`);

    try {
      try { git.fetchAll(this.repoDir); } catch {}
      git.pruneWorktrees(this.repoDir);
      if (git.worktreeExists(cwd, this.repoDir)) git.removeWorktree(cwd, this.repoDir);
      git.addWorktreeTracking(cwd, event.branch, this.repoDir);
    } catch (err: any) {
      log.warn(`Could not check out ${event.branch} for preview verification of ${label}: ${err.message}`);
      return;
    }

    let outcome: previewVerify.PreviewVerifyOutcome;
    try {
      log.info(`Running preview verification for ${label} against ${url}...`);
      outcome = await previewVerify.verifyPreview(config, {
        url,
        cwd,
        env: { FOUNDRY_BRANCH: event.branch, FOUNDRY_PR_NUMBER: String(event.pr_number) },
        sha: event.sha, branch: event.branch, pr_number: event.pr_number,
      });
    } finally {
      try { git.removeWorktree(cwd, this.repoDir); } catch {}
    }

    (outcome.passed ? log.success : log.error)(`Preview verification ${outcome.passed ? 'passed' : 'failed'} for ${label}.`);

    const body = PREVIEW_VERIFY_MARKER + '\n' + previewVerify.formatPreviewVerify(outcome);
    try {
      const comments = await github.getComments(config.repo, event.pr_number);
      const existing = comments.find(c => c.body.includes(PREVIEW_VERIFY_MARKER));
      if (existing) await github.updateComment(config.repo, existing.id, body);
      else await github.commentOnPR(config.repo, event.pr_number, body);
    } catch (err: any) {
      log.warn(`Could not post preview verification on ${label}: ${err.message}`);
    }

    try {
      await github.createCheckRun(config.repo, {
        name: 'Foundry Preview Verification',
        head_sha: event.sha,
        status: 'completed',
        conclusion: outcome.passed ? 'success' : 'failure',
        output: {
          title: outcome.passed ? 'Preview verification passed' : 'Preview verification failed',
          summary: previewVerify.formatPreviewVerify(outcome),
        },
      });
    } catch (err: any) {
      log.warn(`Failed to create check run for ${label}: ${err.message}`);
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
    const workerId = git.workerId(issue.number);
    const issueLabels = issue.labels.map(l => l.name);
    const backend = resolveBackendForIssue(config, issueLabels);

    log.info(`Claiming #${issue.number}: ${issue.title}`);

    const claimed = await claim.claimIssue(config, issue, {
      runner_id: runnerId,
      branch,
      worktree,
      tmux_session: workerId,
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
      id: workerId,
      cwd: worktree,
      command: agentCommand,
      env: this.launchEnv({ issue: issue.number, title: issue.title, body: issue.body ?? '' }, agentEnv),
    });

    const taskState: TaskState = {
      issue: issue.number,
      title: issue.title,
      issue_body: issue.body ?? '',
      repo: config.repo,
      branch,
      worktree,
      tmux_session: workerId,
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

    log.success(`Agent launched in ${workerId}`);
  }

  // ── Issue Claim (claim only, no agent) ───────────────────────────────

  private async handleIssueClaim(event: IssueClaimEvent): Promise<void> {
    const { issue } = event;
    const config = this.config;
    const repoDir = this.repoDir;

    const runnerId = state.getRunnerId();
    const branch = git.resolveBranchName(config.branch_template, issue.number, issue.title);
    const worktree = git.resolveWorktreePath(config.worktree_base, issue.number, issue.title, repoDir);
    const workerId = git.workerId(issue.number);
    const issueLabels = issue.labels.map(l => l.name);
    const backend = resolveBackendForIssue(config, issueLabels);

    log.info(`Claim-only #${issue.number}: ${issue.title}`);

    const claimed = await claim.claimIssueOnly(config, issue, {
      runner_id: runnerId,
      branch,
      worktree,
      tmux_session: workerId,
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
      issue_body: issue.body ?? '',
      repo: config.repo,
      branch,
      worktree,
      tmux_session: workerId,
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

    try { await setStateLabel(config, task.issue, 'done'); } catch {}
    try { await github.closeIssue(config.repo, task.issue); } catch {}

    try { git.removeWorktree(task.worktree, repoDir); } catch {}
    try { git.deleteBranch(task.branch, repoDir); } catch {}
    state.removeTask(config.repo, task.issue);

    log.success(`Auto-cleaned resources for #${task.issue}.`);

    // integration moved: any sibling PR that now conflicts gets its agent back.
    await stalePRs.handleStalePRs(config, event.base ?? 'integration', task.pr_number);
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

    if (outcome.session_id || outcome.usage) {
      state.updateTaskStatus(config.repo, task.issue, task.status, {
        ...(outcome.session_id ? { session_id: outcome.session_id } : {}),
        ...(outcome.usage ? { last_run: outcome.usage } : {}),
      });
    }

    switch (outcome.type) {
      case 'completed':
        await this.handleCompleted(task, outcome);
        break;
      case 'plan-completed':
        await this.handlePlanCompleted(task, outcome);
        break;
      case 'needs-input':
        await this.handleNeedsInput(task, outcome);
        break;
      case 'blocked':
      case 'errored':
        log.error(`Agent for #${task.issue} ${outcome.type}: ${outcome.reason ?? 'no reason given'}`);
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
            historyEntry: outcome.type === 'blocked' ? 'Agent blocked' : 'Agent errored',
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

    await setStateLabel(config, task.issue, 'in_progress');

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
    await setStateLabel(config, task.issue, 'failed');

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

    await setStateLabel(config, task.issue, 'ready');

    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: { ...task, status: 'stopped' },
      message: 'Work discarded per `@foundry restart`. The issue has been re-queued and will be claimed on the next poll cycle.',
      historyEntry: 'Restarted via @foundry restart',
    });

    log.success(`Restarted #${task.issue} via @foundry restart — re-queued as ready`);
  }

  private async handleCommandReplan(task: TaskState): Promise<void> {
    const config = this.config;
    ensureWorktree(task, this.repoDir);

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
      env: this.launchEnv(this.briefFor(task), agentEnv),
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
    ensureWorktree(task, this.repoDir);

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
      env: this.launchEnv(this.briefFor(task), agentEnv),
    });

    await setStateLabel(config, task.issue, 'in_progress');

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

    await setStateLabel(config, task.issue, 'ready');

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

  /**
   * The last mile after a PR exists: deploy the preview, verify against it
   * when `verify_preview` is configured, and only then mark the task ready
   * for human review. A failed preview verification fails the task with the
   * output on the issue, exactly like a failed build.
   */
  private async finishReadyForReview(task: TaskState, message: string, historyEntry: string, prUrl?: string): Promise<void> {
    const config = this.config;
    const fresh = () => state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? task;

    await triggerPreviewUp(config, task);

    let verified: previewVerify.PreviewVerifyOutcome | null = null;
    if (previewVerify.isConfigured(config)) {
      const current = fresh();
      if (!current.preview_url) {
        verified = {
          passed: false,
          url: '(none)',
          results: [{ command: 'preview', success: false, output: 'verify_preview is configured but no preview URL was produced. Check the `preview` section of .joynt-foundry.yml.', duration_ms: 0 }],
        };
      } else {
        log.info(`Running preview verification for #${task.issue} against ${current.preview_url}...`);
        verified = await previewVerify.verifyPreview(config, {
          url: current.preview_url,
          cwd: current.worktree,
          env: {
            FOUNDRY_ISSUE: String(task.issue),
            FOUNDRY_BRANCH: current.branch,
            FOUNDRY_PR_NUMBER: String(current.pr_number ?? ''),
          },
          sha: git.headSha(current.worktree), branch: current.branch, pr_number: current.pr_number,
        });
      }

      if (!verified.passed) {
        log.error(`Preview verification failed for #${task.issue}.`);
        state.updateTaskStatus(config.repo, task.issue, 'failed');
        await claim.markFailed(config, task.issue);
        await statusComment.updateStatusComment(config.repo, task.issue, {
          task: { ...fresh(), status: 'failed' },
          prUrl,
          message: previewVerify.formatPreviewVerify(verified) + '\n\n`@foundry restart` to retry from scratch · `@foundry start` to re-queue',
          historyEntry: 'Preview verification failed',
        });
        return;
      }
      log.success(`Preview verification passed for #${task.issue}.`);
    }

    await setStateLabel(config, task.issue, 'ready_for_review');
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: { ...fresh(), status: 'pr-open' },
      prUrl,
      message: [
        message,
        verified ? `Preview verification passed (${verified.results.length} check${verified.results.length === 1 ? '' : 's'}).` : null,
        '',
        'Foundry is watching this PR. Submit a review with **Request changes**, or reply on this issue with feedback.',
      ].filter(l => l !== null).join('\n'),
      historyEntry: verified ? `${historyEntry}, preview verified` : historyEntry,
    });
  }

  private async handleCompleted(task: TaskState, outcome?: AgentOutcome): Promise<void> {
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
        // --force-with-lease: a relaunched agent may have rebased. The lease is
        // the remote-tracking ref this job fetched, so a push by anyone else
        // since then is still refused.
        git.push(task.branch, task.worktree, true);
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
        await this.finishReadyForReview(task, 'Verification passed. PR updated with new changes.', 'Verification passed, PR updated');
      } else {
        try {
          const prUrl = await github.createPR(config.repo, {
            title: `#${task.issue}: ${task.title}`,
            body: buildPRBody(task, outcome),
            head: task.branch,
            base: 'integration',
          });
          log.success(`PR created: ${prUrl}`);
          const prNumber = github.extractPRNumber(prUrl);
          state.updateTaskStatus(config.repo, task.issue, 'pr-open', {
            pr_url: prUrl,
            pr_number: prNumber ?? undefined,
          });
          await this.finishReadyForReview(task, 'Verification passed. PR created and ready for review.', 'Verification passed, PR created', prUrl);
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

    const preserved = preserveWork(task, this.repoDir, 'waiting for input');

    try {
      await setStateLabel(config, task.issue, 'waiting_for_input');
    } catch {}

    state.updateTaskStatus(config.repo, task.issue, 'waiting-for-input', {
      session_id: outcome.session_id ?? task.session_id,
      input_request_count: inputRound,
      last_agent_message: outcome.final_message ?? undefined,
    });

    const inputComment = agentOutput.formatInputRequestComment(outcome, inputRound);
    const inputMsg = inputComment.replace('<!-- foundry-input-request -->\n', '')
      + (preserved.pushed ? `\n\n_Work so far is on \`${task.branch}\`._` : '');

    const waitingTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'waiting-for-input' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: waitingTask,
      message: inputMsg,
      historyEntry: `Input needed (round ${inputRound})`,
    });
  }

  private async handlePlanCompleted(task: TaskState, outcome: AgentOutcome): Promise<void> {
    const config = this.config;

    preserveWork(task, this.repoDir, 'plan review');

    // Post the plan-review comment separately — it has its own marker used for detecting responses
    const planComment = [
      '<!-- foundry-plan-review -->',
      '**Foundry Agent — Plan for Review**',
      '',
      outcome.final_message ?? 'No plan content captured.',
      '',
      '---',
      'Reply to this issue to approve the plan, or with feedback to have it revised.',
      '',
      'Or: `@foundry restart` · `@foundry stop`',
    ].join('\n');

    await postToConversationTarget(config, task, planComment);

    await setStateLabel(config, task.issue, 'plan_review');

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
    ensureWorktree(task, this.repoDir);

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
      env: this.launchEnv(this.briefFor(task), agentEnv),
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      agent_command: agentCommand,
      permission_mode: permissionMode,
    });
    log.success(`Agent launched from claimed state for #${task.issue} in ${task.tmux_session}`);
  }

  private async resumeAgent(task: TaskState, humanResponse: string): Promise<void> {
    const config = this.config;
    ensureWorktree(task, this.repoDir);

    await setStateLabel(config, task.issue, 'in_progress');

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

    // The agent is relaunched, not resumed: sessions do not survive jobs. What
    // it asked and what the human answered go in FOUNDRY_RESUME_CONTEXT, which
    // the preset's prompt includes.
    const command = backend.resolveCommand(launchParams);
    const resumeKind = task.status === 'plan-review' ? 'plan' : 'answer';

    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command,
      env: this.launchEnv(this.briefFor(task), backend.resolveEnv(launchParams), {
        FOUNDRY_RESUME_CONTEXT: buildResumeContext(task, humanResponse, resumeKind),
      }),
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      permission_mode: '--dangerously-skip-permissions',
    });
    log.success(`Resumed agent for #${task.issue} in ${task.tmux_session}`);
  }

  private async resumeAgentForPR(task: TaskState, feedback: string): Promise<void> {
    const config = this.config;
    ensureWorktree(task, this.repoDir);

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

    const command = backend.resolveCommand(launchParams);

    await worker.spawn({
      id: task.tmux_session,
      cwd: task.worktree,
      command,
      env: this.launchEnv(this.briefFor(task), backend.resolveEnv(launchParams), {
        FOUNDRY_RESUME_CONTEXT: buildResumeContext(task, feedback, 'review'),
      }),
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
