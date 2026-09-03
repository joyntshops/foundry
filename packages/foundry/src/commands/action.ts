/**
 * foundry action — run the Foundry state machine for one GitHub event.
 *
 * Designed to be the entry point of the composite GitHub Action. A job is
 * started by a GitHub event (issue labeled, comment created, PR closed, review
 * submitted), this command maps the event to FoundryEvents, dispatches them
 * through the same EventHandler the runner uses, and, when a handler launched
 * an agent, waits for it and feeds the outcome back in. The job ends when the
 * state machine has nothing left to do for this event.
 *
 * Differences from `foundry run`:
 *   - No polling. One event in, one job.
 *   - The agent runs as a subprocess of this process (SubprocessWorker), so
 *     the job log is the agent transcript.
 *   - Local state starts empty every time. Tasks referenced by the event are
 *     rebuilt from GitHub (task-recovery.ts) before mapping.
 */
import * as fs from 'node:fs';
import { loadConfig, getConfigDir } from '../config.js';
import { EventHandler } from '../lib/event-handler.js';
import { webhookToEvents } from '../lib/webhook.js';
import { recoverTask, issueNumberFromPayload } from '../lib/task-recovery.js';
import { buildAgentCompletedEvent, agentLogPath } from '../lib/completion.js';
import { resolveWorker } from '../lib/workers/index.js';
import * as github from '../lib/github.js';
import * as state from '../lib/state.js';
import * as log from '../lib/log.js';
import type { FoundryConfig, TaskState } from '../types.js';
import type { FoundryEvent } from '../lib/events.js';

export interface ActionOptions {
  eventName?: string;
  eventPath?: string;
}

/** Safety valve: the completion loop never runs more than this many rounds per job. */
const MAX_COMPLETION_ROUNDS = 10;

export async function runAction(opts: ActionOptions): Promise<void> {
  const eventName = opts.eventName ?? process.env.GITHUB_EVENT_NAME;
  const eventPath = opts.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) {
    throw new Error('foundry action needs GITHUB_EVENT_NAME and GITHUB_EVENT_PATH (or --event-name/--event-path).');
  }

  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf-8')) as Record<string, any>;
  const action = payload.action ? `${eventName}.${payload.action}` : eventName;

  const config = loadConfig();
  const repoDir = getConfigDir();

  const payloadRepo: string | undefined = payload.repository?.full_name;
  if (payloadRepo && payloadRepo !== config.repo) {
    log.warn(`Event is for ${payloadRepo} but .joynt-foundry.yml says ${config.repo}.`);
  }

  log.info(`Foundry action: ${action} on ${config.repo}`);

  // Rebuild the referenced task from GitHub so webhookToEvents can find it.
  const issueNumber = issueNumberFromPayload(payload, config);
  if (issueNumber !== null && !state.getTask(config.repo, issueNumber)) {
    const recovered = await recoverTask(config, repoDir, issueNumber);
    if (recovered) {
      state.upsertTask(config.repo, recovered);
      log.info(`Recovered task #${issueNumber} (${recovered.status}) from GitHub.`);
    }
  }

  const events = webhookToEvents(eventName, payload, config);
  if (events.length === 0) {
    log.info(`No Foundry events for ${action}. Nothing to do.`);
    writeOutputs(config, issueNumber);
    return;
  }

  const handler = new EventHandler(config, repoDir);

  for (const event of events) {
    log.info(`Handling ${describe(event)}`);
    await handler.handleEvent(event);
    await driveToCompletion(config, repoDir, handler);
  }

  await continueIfRequeued(config, repoDir, handler, issueNumber);

  writeOutputs(config, issueNumber);
}

/**
 * `@foundry restart` and `@foundry start` end by dropping the task and putting
 * `state:ready` back on the issue, expecting the next poll to pick it up. In a
 * job there is no next poll, and a label added with the job's own token does
 * not start another run. So if the issue we acted on is now ready and
 * untracked, carry straight on into issue_ready here.
 */
async function continueIfRequeued(
  config: FoundryConfig,
  repoDir: string,
  handler: EventHandler,
  issueNumber: number | null,
): Promise<void> {
  if (issueNumber === null) return;
  if (state.getTask(config.repo, issueNumber)) return;

  const issue = await github.getIssue(config.repo, issueNumber);
  if (!github.hasLabel(issue, config.labels.ready)) return;

  log.info(`#${issueNumber} was re-queued. Continuing into issue_ready in this job.`);
  await handler.handleEvent({ type: 'issue_ready', issue });
  await driveToCompletion(config, repoDir, handler);
}

/**
 * If a handler launched an agent, wait for it, classify the outcome, and hand
 * it back to the handler. The handler may launch again (e.g. a future
 * verify-retry round), so loop until no agent is running.
 */
async function driveToCompletion(config: FoundryConfig, repoDir: string, handler: EventHandler): Promise<void> {
  const worker = resolveWorker('subprocess');

  for (let round = 0; round < MAX_COMPLETION_ROUNDS; round++) {
    const running = state.getAllTasks(config.repo)
      .filter(t => t.status === 'agent-running' || t.status === 'resuming');
    if (running.length === 0) return;

    for (const task of running) {
      const handle = worker.handleFor(task.tmux_session);
      if (!handle.wait) {
        log.warn(`Worker for #${task.issue} cannot be awaited; leaving it.`);
        return;
      }
      log.info(`Waiting for agent on #${task.issue}...`);
      const code = await handle.wait();
      log.info(`Agent for #${task.issue} exited (${code ?? 'signal'}). Analyzing outcome...`);

      const fresh = state.getTask(config.repo, task.issue) ?? task;
      await handler.handleEvent(buildAgentCompletedEvent(config, repoDir, fresh));
    }
  }

  log.warn(`Stopped after ${MAX_COMPLETION_ROUNDS} completion rounds.`);
}

function describe(event: FoundryEvent): string {
  switch (event.type) {
    case 'issue_ready':
    case 'issue_claim':
      return `${event.type} #${event.issue.number}`;
    case 'command':
      return `command "${event.command}" on #${event.task.issue} by ${event.commentAuthor}`;
    default:
      return `${event.type} #${event.task.issue}`;
  }
}

/** Expose the outcome to later workflow steps via $GITHUB_OUTPUT. */
function writeOutputs(config: FoundryConfig, issueNumber: number | null): void {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;

  const task: TaskState | undefined = issueNumber !== null ? state.getTask(config.repo, issueNumber) : undefined;
  const lines = [
    `issue=${issueNumber ?? ''}`,
    `status=${task?.status ?? ''}`,
    `branch=${task?.branch ?? ''}`,
    `pr-url=${task?.pr_url ?? ''}`,
    `log-dir=${issueNumber !== null ? state.getLogDir(config.repo, issueNumber) : ''}`,
    `log-path=${issueNumber !== null ? agentLogPath(config, issueNumber) : ''}`,
  ];
  fs.appendFileSync(out, lines.join('\n') + '\n');
}
