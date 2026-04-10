/**
 * Foundry event type definitions.
 *
 * FoundryEvent is a discriminated union describing everything
 * that can happen in the system.  Today events come from the Poller;
 * Phase 2 webhooks will produce the same types.
 */
import type { AgentOutcome, GitHubIssue, TaskState } from '../types.js';

// ── Event types ──────────────────────────────────────────────────────────

export type FoundryEvent =
  | CommandEvent
  | IssueReadyEvent
  | IssueClaimEvent
  | PRMergedEvent
  | PRReviewEvent
  | AgentCompletedEvent
  | HumanResponseEvent
  | PlanApprovedEvent;

export interface CommandEvent {
  type: 'command';
  task: TaskState;
  command: 'replan' | 'restart' | 'stop' | 'continue' | 'plan' | 'start';
  message?: string;
  commentId: number;
  commentAuthor: string;
}

export interface IssueReadyEvent {
  type: 'issue_ready';
  issue: GitHubIssue;
}

export interface IssueClaimEvent {
  type: 'issue_claim';
  issue: GitHubIssue;
}

export interface PRMergedEvent {
  type: 'pr_merged';
  task: TaskState;
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

export interface HumanResponseEvent {
  type: 'human_response';
  task: TaskState;
  response: string;
}

export interface PlanApprovedEvent {
  type: 'plan_approved';
  task: TaskState;
  response: string;
}
