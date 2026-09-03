/**
 * Poller — detects events by polling GitHub and local state.
 *
 * Each poll cycle produces FoundryEvent instances that are dispatched to
 * an EventHandler.  This separates event *detection* from event *handling*,
 * enabling Phase 2 webhooks to produce the same events without polling.
 */
import * as path from 'node:path';
import * as github from './github.js';
import { resolveWorker } from './workers/index.js';
import type { Worker } from './worker.js';
import * as state from './state.js';
import * as claim from './claim.js';
import * as log from './log.js';
import { buildAgentCompletedEvent } from './completion.js';
import type { FoundryConfig, GitHubComment, TaskState } from '../types.js';
import type { FoundryEvent } from './events.js';
import { EventHandler } from './event-handler.js';

// ── Comment command parsing (kept from run.ts) ──────────────────────────

interface ParsedCommand {
  command: 'replan' | 'restart' | 'stop' | 'continue' | 'plan' | 'start' | 'claim';
  message?: string;
  author: string;
}

function isHumanAuthor(login: string): boolean {
  return !login.includes('[bot]') && login !== 'github-actions' && login !== 'foundry';
}

function parseCommentCommand(body: string, author: string, config: FoundryConfig): ParsedCommand | null {
  const triggers = config.comment_triggers;
  const trimmed = body.trim();
  const firstLine = trimmed.split('\n')[0].trim();

  if (trimmed.startsWith(triggers.continue)) {
    const msg = trimmed.slice(triggers.continue.length).trim();
    return { command: 'continue', message: msg || undefined, author };
  }
  if (trimmed.startsWith(triggers.start)) {
    const msg = trimmed.slice(triggers.start.length).trim();
    return { command: 'start', message: msg || undefined, author };
  }
  if (trimmed.startsWith(triggers.plan)) {
    const msg = trimmed.slice(triggers.plan.length).trim();
    return { command: 'plan', message: msg || undefined, author };
  }

  if (firstLine === triggers.replan) return { command: 'replan', author };
  if (firstLine === triggers.restart) return { command: 'restart', author };
  if (firstLine === triggers.stop) return { command: 'stop', author };
  if (firstLine === triggers.claim) return { command: 'claim', author };

  return null;
}

function getValidStatesForCommand(command: ParsedCommand['command']): TaskState['status'][] {
  switch (command) {
    case 'replan':
      return ['agent-running'];
    case 'restart':
      return ['agent-running', 'waiting-for-input', 'failed', 'plan-review', 'claimed'];
    case 'stop':
      return ['agent-running', 'waiting-for-input', 'resuming', 'claimed'];
    case 'continue':
      return ['pr-open', 'waiting-for-input', 'plan-review', 'claimed'];
    case 'plan':
      return ['agent-running', 'waiting-for-input', 'plan-review', 'claimed'];
    case 'start':
      return ['failed', 'stopped', 'claimed'];
    case 'claim':
      return [];
  }
}

async function getPRComments(repo: string, prNumber: number): Promise<GitHubComment[]> {
  return github.getComments(repo, prNumber);
}

// ── Poller ───────────────────────────────────────────────────────────────

export class Poller {
  constructor(
    private config: FoundryConfig,
    private repoDir: string,
    private handler: EventHandler,
    private isRunning: () => boolean,
  ) {}

  /** Run a single poll cycle: detect events then dispatch them. */
  async poll(): Promise<void> {
    const events = await this.detectEvents();
    for (const event of events) {
      await this.handler.handleEvent(event);
    }
  }

  /** Detect all events for this cycle. */
  private async detectEvents(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];

    // 1. Comment commands (highest priority — user intent)
    events.push(...await this.detectCommentCommands());

    // 2. Claim-only requests
    events.push(...await this.detectClaimRequests());

    // 3. Merged PRs
    events.push(...await this.detectMergedPRs());

    // 4. Human responses to waiting tasks
    events.push(...await this.detectHumanResponses());

    // 5. PR review feedback
    events.push(...await this.detectPRFeedback());

    // 6. Plan review responses
    events.push(...await this.detectPlanReviewResponses());

    // 7. Completed agents
    events.push(...await this.detectCompletedAgents());

    // 8. Ready issues (capacity permitting)
    const activeCount = state.getActiveTaskCount(this.config.repo);
    if (activeCount < this.config.max_sessions) {
      events.push(...await this.detectReadyIssues());
    } else {
      log.debug(`At capacity: ${activeCount}/${this.config.max_sessions} sessions.`);
    }

    return events;
  }

  // ── Comment commands ─────────────────────────────────────────────────

  private async detectCommentCommands(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];
    const tasks = state.getAllTasks(this.config.repo);
    const activeTasks = tasks.filter(t => t.status !== 'done');

    for (const task of activeTasks) {
      if (!this.isRunning()) break;

      try {
        const comments = task.pr_number
          ? await getPRComments(this.config.repo, task.pr_number)
          : await github.getComments(this.config.repo, task.issue);

        const taskUpdated = new Date(task.updated_at).getTime();

        for (const comment of comments) {
          const commentTime = new Date(comment.created_at).getTime();
          if (commentTime <= taskUpdated) continue;

          const login = comment.user?.login ?? '';
          if (!isHumanAuthor(login)) continue;

          const cmd = parseCommentCommand(comment.body, login, this.config);
          if (!cmd) continue;

          const validStates = getValidStatesForCommand(cmd.command);
          if (!validStates.includes(task.status)) {
            log.debug(`Ignoring @foundry ${cmd.command} for #${task.issue} — invalid in state "${task.status}"`);
            continue;
          }

          log.info(`@foundry ${cmd.command} from ${cmd.author} for #${task.issue}`);

          // Acknowledge with :eyes: reaction
          try {
            await github.createReactionForIssueComment(this.config.repo, comment.id, 'eyes');
          } catch {}

          // 'claim' is not valid on any existing task; skip
          if (cmd.command === 'claim') continue;

          events.push({
            type: 'command',
            task,
            command: cmd.command,
            message: cmd.message,
            commentId: comment.id,
            commentAuthor: cmd.author,
          });

          // Only process the first matching command per task per poll cycle
          break;
        }
      } catch (err: any) {
        log.error(`Error checking comment commands for #${task.issue}: ${err.message}`);
      }
    }

    return events;
  }

  // ── Claim requests ───────────────────────────────────────────────────

  private async detectClaimRequests(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];

    let issues;
    try {
      issues = await github.listIssuesByLabel(this.config.repo, this.config.labels.claim);
    } catch (err: any) {
      log.error(`Error polling for claim requests: ${err.message}`);
      return events;
    }

    if (issues.length === 0) return events;

    log.info(`Found ${issues.length} claim request(s).`);

    for (const issue of issues) {
      if (!this.isRunning()) break;
      if (claim.isClaimedByUs(this.config, issue.number)) continue;

      events.push({ type: 'issue_claim', issue });
    }

    return events;
  }

  // ── Merged PRs ───────────────────────────────────────────────────────

  private async detectMergedPRs(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];
    const tasks = state.getAllTasks(this.config.repo);
    const prOpenTasks = tasks.filter(t => t.status === 'pr-open');

    for (const task of prOpenTasks) {
      if (!this.isRunning()) break;

      try {
        const prStatus = await github.getPRStatus(this.config.repo, task.branch);
        if (!prStatus) continue;

        if (prStatus.state === 'MERGED' || prStatus.state === 'closed' && prStatus.url === task.pr_url) {
          const isMerged = prStatus.state === 'MERGED';
          if (!isMerged) continue;

          events.push({ type: 'pr_merged', task });
        }
      } catch (err: any) {
        log.error(`Error checking merged PR for #${task.issue}: ${err.message}`);
      }
    }

    return events;
  }

  // ── Human responses ──────────────────────────────────────────────────

  private async detectHumanResponses(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];
    const tasks = state.getAllTasks(this.config.repo);
    const waitingTasks = tasks.filter(t => t.status === 'waiting-for-input');

    for (const task of waitingTasks) {
      if (!this.isRunning()) break;

      try {
        const humanResponse = await this.findHumanResponse(task);
        if (humanResponse) {
          events.push({ type: 'human_response', task, response: humanResponse });
        }
      } catch (err: any) {
        log.error(`Error checking waiting task #${task.issue}: ${err.message}`);
      }
    }

    return events;
  }

  private async findHumanResponse(task: TaskState): Promise<string | null> {
    const comments = task.pr_number
      ? await getPRComments(this.config.repo, task.pr_number)
      : await github.getComments(this.config.repo, task.issue);

    let lastRequestIndex = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].body.includes('<!-- foundry-input-request -->')) {
        lastRequestIndex = i;
        break;
      }
    }

    if (lastRequestIndex === -1) return null;

    const repliesAfterRequest = comments.slice(lastRequestIndex + 1);
    const humanReplies = repliesAfterRequest.filter(c => {
      const login = c.user?.login ?? '';
      return !login.includes('[bot]') && login !== 'github-actions' && login !== 'foundry';
    });

    if (humanReplies.length === 0) return null;
    return humanReplies.map(c => c.body).join('\n\n');
  }

  // ── PR feedback ──────────────────────────────────────────────────────

  private async detectPRFeedback(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];
    const tasks = state.getAllTasks(this.config.repo);
    const prOpenTasks = tasks.filter(t => t.status === 'pr-open');

    for (const task of prOpenTasks) {
      if (!this.isRunning()) break;

      const prNumber = task.pr_number ?? (task.pr_url ? github.extractPRNumber(task.pr_url) : null);
      if (!prNumber) continue;

      // Persist pr_number if we just extracted it
      if (!task.pr_number) {
        state.updateTaskStatus(this.config.repo, task.issue, task.status, { pr_number: prNumber });
      }

      try {
        const feedback = await this.findPRFeedback(prNumber, task);
        if (feedback) {
          events.push({ type: 'pr_review', task, feedback });
        }
      } catch (err: any) {
        log.error(`Error checking PR feedback for #${task.issue}: ${err.message}`);
      }
    }

    return events;
  }

  private async findPRFeedback(prNumber: number, task: TaskState): Promise<string | null> {
    const { reviews, comments } = await github.getPRReviews(this.config.repo, prNumber);

    const taskUpdated = new Date(task.updated_at).getTime();

    const newChangeRequests = reviews.filter(r =>
      r.state === 'CHANGES_REQUESTED' &&
      new Date(r.submittedAt).getTime() > taskUpdated
    );

    const newReviewComments = comments.filter(c =>
      new Date(c.createdAt).getTime() > taskUpdated
    );

    if (newChangeRequests.length === 0 && newReviewComments.length === 0) return null;

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

  // ── Plan review responses ────────────────────────────────────────────

  private async detectPlanReviewResponses(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];
    const tasks = state.getAllTasks(this.config.repo);
    const planTasks = tasks.filter(t => t.status === 'plan-review');

    for (const task of planTasks) {
      if (!this.isRunning()) break;

      try {
        const response = await this.findPlanResponse(task);
        if (response) {
          events.push({ type: 'plan_approved', task, response });
        }
      } catch (err: any) {
        log.error(`Error checking plan review for #${task.issue}: ${err.message}`);
      }
    }

    return events;
  }

  private async findPlanResponse(task: TaskState): Promise<string | null> {
    const comments = task.pr_number
      ? await getPRComments(this.config.repo, task.pr_number)
      : await github.getComments(this.config.repo, task.issue);

    let lastPlanIndex = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].body.includes('<!-- foundry-plan-review -->')) {
        lastPlanIndex = i;
        break;
      }
    }

    if (lastPlanIndex === -1) return null;

    const repliesAfterPlan = comments.slice(lastPlanIndex + 1);
    const humanReplies = repliesAfterPlan.filter(c => {
      const login = c.user?.login ?? '';
      return !login.includes('[bot]') && login !== 'github-actions' && login !== 'foundry';
    });

    if (humanReplies.length === 0) return null;
    return humanReplies.map(c => c.body).join('\n\n');
  }

  // ── Completed agents ─────────────────────────────────────────────────

  private async detectCompletedAgents(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];
    const worker = resolveWorker(this.config.worker?.type);
    const tasks = state.getAllTasks(this.config.repo);
    const runningTasks = tasks.filter(t => t.status === 'agent-running' || t.status === 'resuming');

    for (const task of runningTasks) {
      const handle = worker.handleFor(task.tmux_session);
      if (!(await handle.isRunning())) {
        log.info(`Agent for #${task.issue} has exited. Analyzing outcome...`);
        events.push(buildAgentCompletedEvent(this.config, this.repoDir, task));
      }
    }

    return events;
  }

  // ── Ready issues ─────────────────────────────────────────────────────

  private async detectReadyIssues(): Promise<FoundryEvent[]> {
    const events: FoundryEvent[] = [];

    log.debug('Polling for ready issues...');
    const issues = await github.listIssuesByLabel(this.config.repo, this.config.labels.ready);

    if (issues.length === 0) {
      log.debug('No ready issues found.');
      return events;
    }

    log.info(`Found ${issues.length} ready issue(s).`);

    for (const issue of issues) {
      if (!this.isRunning()) break;
      if (state.getActiveTaskCount(this.config.repo) >= this.config.max_sessions) break;
      if (claim.isClaimedByUs(this.config, issue.number)) continue;

      events.push({ type: 'issue_ready', issue });
    }

    return events;
  }
}
