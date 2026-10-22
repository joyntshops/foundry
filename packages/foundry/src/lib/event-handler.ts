/**
 * EventHandler — processes FoundryEvent instances.
 *
 * All behavior lives here; `commands/action.ts` is composition only. Humans
 * drive a task with three commands (`go`, `restart`, `stop`); everything
 * else that moves a task is a review, a merge, or the agent finishing.
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
import { preserveWork, ensureWorktree, type PreserveResult } from './worktree.js';
import { writeIssueFile } from './issue-file.js';
import { collectThread, type ThreadComment } from './thread.js';
import * as previewVerify from './preview-verify.js';
import * as path from 'node:path';
import * as stalePRs from './stale-prs.js';
import * as review from './review.js';
import { resolveBackend, resolveBackendForIssue } from '../backends/index.js';
import * as preview from './preview.js';
import * as statusComment from './status-comment.js';
import type { FoundryConfig, TaskState, AgentLaunchParams, AgentOutcome, GitHubIssue } from '../types.js';
import type {
  FoundryEvent,
  CommandEvent,
  PRMergedEvent,
  PRReviewEvent,
  AgentCompletedEvent,
  PRPreviewEvent,
  PRApprovedEvent,
} from './events.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const PREVIEW_VERIFY_MARKER = '<!-- foundry-preview-verify -->';

/** What every non-success ending tells the human. */
export const FAILED_FOOTER = '`@foundry go` to continue from the branch · `@foundry restart` to start over';

function workOnBranch(task: TaskState, preserved: PreserveResult): string[] {
  return preserved.pushed ? [`_Work so far is on \`${task.branch}\`._`] : [];
}

export type ResumeKind = 'answer' | 'plan' | 'review' | 'go';

/**
 * What a relaunched agent is told about why it is being launched again. Goes
 * in FOUNDRY_RESUME_CONTEXT; the Claude preset's prompt includes it.
 */
export function buildResumeContext(task: TaskState, humanText: string, kind: ResumeKind): string {
  const lastReport = task.last_agent_message ? ` Your last report: "${task.last_agent_message}".` : '';
  const prNote = task.pr_url ? ` Your pull request ${task.pr_url} is open; commits you add to the branch update it.` : '';
  const intro = {
    answer: `You stopped earlier because you needed a decision from a human${task.last_agent_message ? `; you reported: "${task.last_agent_message}"` : ' (your questions are in your last status comment on the issue)'}. The human replied:`,
    plan: `You posted a plan for this issue and the human reviewed it. Their reply:`,
    review: `A reviewer requested changes on your pull request:`,
    go: `The human commented \`@foundry go\` on the issue.${prNote}${lastReport} Their message:`,
  }[kind];
  const outro = {
    answer: 'Apply the reply and continue the task.',
    plan: 'If the reply approves the plan, implement it now; if it asks for changes, revise the plan and report plan_ready again.',
    review: 'Address the review on this branch and commit.',
    go: 'The issue file holds the whole thread, including every comment since your last launch; read it, then finish the task from the branch and report.',
  }[kind];
  const text = humanText.trim() || '(no message; see the thread in the issue file)';
  return [
    `RESUMING issue #${task.issue} on branch ${task.branch}. The branch already holds your earlier commits; continue from its current state, do not start over.`,
    '',
    intro,
    '',
    text,
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
  parts.push('---', `Opened by Foundry (${task.agent_backend}). Request changes on this PR, or comment \`@foundry go <feedback>\` on the issue, to send the agent back to work.`);
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

/** A task whose job may still hold a live agent process. */
function mayBeRunning(task: TaskState): boolean {
  return task.status !== 'claimed' && task.status !== 'done' && task.status !== 'failed' && task.status !== 'stopped';
}

// ── EventHandler ─────────────────────────────────────────────────────────

export class EventHandler {
  constructor(
    private config: FoundryConfig,
    private repoDir: string,
  ) {}

  /**
   * Environment for an agent launch: the backend's own env plus the issue
   * file (body and the human thread), the report contract (schema + report
   * file, with any previous launch's report cleared), and the turn cap.
   */
  private async launchEnv(
    brief: { issue: number; title: string; body: string },
    backendEnv: Record<string, string> = {},
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const stateDir = state.getTaskStateDir(this.config.repo, brief.issue);
    let comments: ThreadComment[] = [];
    try {
      comments = await collectThread(this.config, brief.issue);
    } catch (err: any) {
      log.warn(`Could not read the comments on #${brief.issue}: ${err.message}. The agent gets the body only.`);
    }
    const issueFile = writeIssueFile(stateDir, {
      number: brief.issue,
      title: brief.title,
      body: brief.body,
      url: `https://github.com/${this.config.repo}/issues/${brief.issue}`,
      comments,
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
      case 'pr_merged':
        return this.handlePRMerged(event);
      case 'pr_review':
        return this.handlePRReview(event);
      case 'agent_completed':
        return this.handleAgentCompleted(event);
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
        const dispatched = stalePRs.dispatchCommand(event.task.issue, 'go', instruction);
        const note = dispatched
          ? `PR #${event.pr_number} was approved but conflicts with \`${event.base}\`. Foundry has sent the agent to rebase and resolve; approve again once it is clean.`
          : `PR #${event.pr_number} was approved but conflicts with \`${event.base}\`. Comment \`@foundry go\` with:\n\n> ${instruction}`;
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

  // ── Commands ─────────────────────────────────────────────────────────

  private async handleCommand(event: CommandEvent): Promise<void> {
    switch (event.command) {
      case 'go':
        return this.handleCommandGo(event);
      case 'restart':
        return this.handleCommandRestart(event);
      case 'stop':
        return this.handleCommandStop(event);
    }
  }

  /**
   * `@foundry go`: start the issue if it has never been started; otherwise
   * proceed from the branch. The agent reads the whole thread from the issue
   * file, so the same command answers a question, approves a plan, revises a
   * PR, or picks up a failed task. On a task whose label still says running,
   * the job that ran it is gone (a live job would have made this one wait),
   * so it is resumed like any other.
   */
  private async handleCommandGo(event: CommandEvent): Promise<void> {
    const config = this.config;
    const { task } = event;

    if (!task || task.status === 'claimed' || task.status === 'done') {
      const issue = await github.getIssue(config.repo, event.issue);
      await this.startTask(issue);
      return;
    }

    const message = event.message ?? '';
    const kind: ResumeKind =
      task.status === 'waiting-for-input' ? 'answer' :
      task.status === 'plan-review' ? 'plan' :
      'go';

    await this.relaunch(task, message, kind);

    const fresh = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'agent-running' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: fresh,
      message: 'Agent is working per `@foundry go`. `@foundry stop` to stop it.',
      historyEntry: 'Resumed via @foundry go',
    });

    log.success(`Resumed #${task.issue} via @foundry go (${kind})`);
  }

  /** `@foundry restart`: discard everything and start the issue again, in this job. */
  private async handleCommandRestart(event: CommandEvent): Promise<void> {
    const config = this.config;
    const { task } = event;

    if (task) {
      if (mayBeRunning(task)) {
        const worker = getWorker(config);
        await worker.handleFor(task.tmux_session).kill();
      }
      await triggerPreviewDown(config, task);
      state.removeTask(config.repo, task.issue);
      await statusComment.updateStatusComment(config.repo, task.issue, {
        task: { ...task, status: 'stopped' },
        message: 'Work discarded per `@foundry restart`. Starting over.',
        historyEntry: 'Restarted via @foundry restart',
      });
      log.info(`Discarded work on #${task.issue} via @foundry restart`);
    }

    // startTask removes the old worktree, branch, and remote branch itself.
    const issue = await github.getIssue(config.repo, event.issue);
    await this.startTask(issue);
  }

  /** `@foundry stop`: stop the agent, keep the branch, mark the task failed. */
  private async handleCommandStop(event: CommandEvent): Promise<void> {
    const config = this.config;
    const { task } = event;
    if (!task) {
      log.info(`#${event.issue} has no task to stop.`);
      return;
    }

    if (mayBeRunning(task)) {
      const worker = getWorker(config);
      await worker.handleFor(task.tmux_session).kill();
    }

    const preserved = preserveWork(task, this.repoDir, 'stopped');
    await triggerPreviewDown(config, task);

    state.updateTaskStatus(config.repo, task.issue, 'failed');
    await setStateLabel(config, task.issue, 'failed');

    const stoppedTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: stoppedTask,
      message: ['Agent stopped per `@foundry stop`.', ...workOnBranch(task, preserved), '', FAILED_FOOTER].join('\n'),
      historyEntry: 'Stopped via @foundry stop',
    });

    log.success(`Stopped agent for #${task.issue} via @foundry stop`);
  }

  // ── Fresh start (claim + worktree + agent) ───────────────────────────

  private async startTask(issue: GitHubIssue): Promise<void> {
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
      env: await this.launchEnv({ issue: issue.number, title: issue.title, body: issue.body ?? '' }, agentEnv),
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
      message: 'Agent is working on this issue. `@foundry stop` to stop it.',
      historyEntry: 'Agent started',
    });

    log.success(`Agent launched in ${workerId}`);
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
        await this.handleFailedRun(task, outcome);
        break;
    }
  }

  /** The agent ended without finishing. The branch is kept so `go` can continue it. */
  private async handleFailedRun(task: TaskState, outcome: AgentOutcome): Promise<void> {
    const config = this.config;
    log.error(`Agent for #${task.issue} ${outcome.type}: ${outcome.reason ?? 'no reason given'}`);

    const preserved = preserveWork(task, this.repoDir, outcome.type);

    state.updateTaskStatus(config.repo, task.issue, 'failed', {
      last_agent_message: outcome.final_message ?? undefined,
    });
    await claim.markFailed(config, task.issue);

    const errorMsg = [
      outcome.final_message ? outcome.final_message.slice(-2000) : 'No error details captured.',
      ...workOnBranch(task, preserved),
      '',
      FAILED_FOOTER,
    ].join('\n');
    const freshTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: freshTask,
      message: errorMsg,
      historyEntry: outcome.type === 'blocked' ? 'Agent blocked' : 'Agent errored',
    });
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
          message: previewVerify.formatPreviewVerify(verified) + '\n\n' + FAILED_FOOTER,
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
        'Foundry is watching this PR. Submit a review with **Request changes**, or comment `@foundry go <feedback>` on this issue.',
      ].filter(l => l !== null).join('\n'),
      historyEntry: verified ? `${historyEntry}, preview verified` : historyEntry,
    });
  }

  private async handleCompleted(task: TaskState, outcome?: AgentOutcome): Promise<void> {
    const config = this.config;

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
          message: `Push failed:\n\n${err.message}\n\n${FAILED_FOOTER}`,
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
            message: `PR creation failed:\n\n${err.message}\n\n${FAILED_FOOTER}`,
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

      // The branch is pushed so `@foundry go` can send the agent back to it.
      const preserved = preserveWork(task, this.repoDir, 'verification failed');

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
        ...workOnBranch(task, preserved),
        '',
        FAILED_FOOTER,
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
      const preserved = preserveWork(task, this.repoDir, 'too many questions');
      state.updateTaskStatus(config.repo, task.issue, 'failed', {
        input_request_count: inputRound,
        last_agent_message: outcome.final_message ?? undefined,
      });
      await claim.markFailed(config, task.issue);
      const giveUpTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'failed' as const };
      await statusComment.updateStatusComment(config.repo, task.issue, {
        task: giveUpTask,
        message: [`Exceeded ${config.max_input_rounds} input rounds. The agent has been unable to complete this task.`, ...workOnBranch(task, preserved), '', FAILED_FOOTER].join('\n'),
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

    // Post the plan-review comment separately — it has its own marker.
    const planComment = [
      '<!-- foundry-plan-review -->',
      '**Foundry Agent — Plan for Review**',
      '',
      outcome.final_message ?? 'No plan content captured.',
      '',
      '---',
      'Comment `@foundry go` to approve the plan, or `@foundry go <feedback>` to have it revised.',
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
      message: 'Plan ready for review. `@foundry go` approves it; `@foundry go <feedback>` revises it.',
      historyEntry: 'Plan completed, awaiting review',
    });

    log.success(`Plan posted for #${task.issue}. Awaiting human review.`);
  }

  // ── Relaunch ─────────────────────────────────────────────────────────

  /**
   * Launch the agent again on the task's branch. Sessions do not survive
   * jobs, so this is a fresh process: the worktree is recreated from the
   * pushed branch, the thread goes in the issue file, and why it is being
   * launched goes in FOUNDRY_RESUME_CONTEXT. Always in auto mode: a plan has
   * been approved or a human has asked for work.
   */
  private async relaunch(task: TaskState, humanText: string, kind: ResumeKind): Promise<void> {
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
      body: humanText,
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
      env: await this.launchEnv(this.briefFor(task), backend.resolveEnv(launchParams), {
        FOUNDRY_RESUME_CONTEXT: buildResumeContext(task, humanText, kind),
      }),
    });

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      permission_mode: '--dangerously-skip-permissions',
    });
    log.success(`Relaunched agent for #${task.issue} in ${task.tmux_session} (${kind})`);
  }

  /** A review requested changes: relaunch with the review, within the input-round cap. */
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
        message: `Exceeded ${config.max_input_rounds} input rounds for PR feedback.\n\n${FAILED_FOOTER}`,
        historyEntry: `Gave up after ${config.max_input_rounds} PR feedback rounds`,
      });
      return;
    }

    await this.relaunch(task, feedback, 'review');

    state.updateTaskStatus(config.repo, task.issue, 'agent-running', {
      input_request_count: inputRound,
      permission_mode: '--dangerously-skip-permissions',
    });

    const prFeedbackTask = state.getAllTasks(config.repo).find(t => t.issue === task.issue) ?? { ...task, status: 'agent-running' as const };
    await statusComment.updateStatusComment(config.repo, task.issue, {
      task: prFeedbackTask,
      message: `Agent is addressing PR review feedback (round ${inputRound}). \`@foundry stop\` to stop it.`,
      historyEntry: `Resumed for PR feedback (round ${inputRound})`,
    });

    log.success(`Resumed agent for #${task.issue} to address PR feedback (round ${inputRound})`);
  }
}
