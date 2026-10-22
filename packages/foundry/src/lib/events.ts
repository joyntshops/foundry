/**
 * Foundry event type definitions.
 *
 * FoundryEvent is a discriminated union describing everything that can move
 * a task. Every event is produced from one GitHub event payload
 * (lib/webhook.ts) or from an agent finishing (lib/completion.ts).
 *
 * Humans act through three commands only. Labels never start work and plain
 * comments never start work; both are inputs the agent reads on its next
 * launch.
 */
import type { AgentOutcome, TaskState } from '../types.js';

// ── Event types ──────────────────────────────────────────────────────────

export type FoundryEvent =
  | CommandEvent
  | PRMergedEvent
  | PRReviewEvent
  | AgentCompletedEvent
  | PRPreviewEvent
  | PRApprovedEvent;

export type FoundryCommand = 'go' | 'restart' | 'stop';

/**
 * `@foundry go|restart|stop` on an issue, or the same delivered through
 * `workflow_dispatch` when Foundry hands work to itself.
 *
 * `task` is null when the issue has never been claimed: `go` and `restart`
 * then start it fresh, `stop` does nothing.
 */
export interface CommandEvent {
  type: 'command';
  issue: number;
  task: TaskState | null;
  command: FoundryCommand;
  message?: string;
  commentId: number;
  commentAuthor: string;
  /** Comments are authorized against the commenter's repo permission; dispatches already needed `actions: write`. */
  via: 'comment' | 'dispatch';
}

export interface PRMergedEvent {
  type: 'pr_merged';
  task: TaskState;
  /** Base branch the PR merged into. */
  base?: string;
}

export interface PRReviewEvent {
  type: 'pr_review';
  task: TaskState;
  feedback: string;
}

export interface AgentCompletedEvent {
  type: 'agent_completed';
  task: TaskState;
  outcome: AgentOutcome;
}

/**
 * Preview lifecycle for a pull request that is not a Foundry task, selected
 * by `preview.pull_request_bases`. `up` on open, reopen, and every push;
 * `down` on close.
 */
export interface PRPreviewEvent {
  type: 'pr_preview';
  action: 'up' | 'down';
  pr_number: number;
  branch: string;
  base: string;
  sha: string;
}

/** An approving review on a task PR or a `pull_request_bases` PR: rebase, check, merge. */
export interface PRApprovedEvent {
  type: 'pr_approved';
  pr_number: number;
  branch: string;
  base: string;
  reviewer: string;
  /** Set when the PR belongs to a Foundry task. */
  task?: TaskState;
}
