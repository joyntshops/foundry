/**
 * EventHandler tests — verify dispatch for each event type.
 *
 * All external dependencies are mocked. Focus is on verifying that
 * handleEvent routes to the correct handler and calls the right state
 * transitions and GitHub API methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FoundryConfig, TaskState, AgentOutcome } from '../types.js';
import type { FoundryEvent } from './events.js';

// ── Mock all external modules ────────────────────────────────────────────

vi.mock('./github.js', () => ({
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  addComment: vi.fn(),
  getIssue: vi.fn(),
  transitionLabels: vi.fn(),
  createPR: vi.fn(),
  closeIssue: vi.fn(),
  commentOnPR: vi.fn(),
  extractPRNumber: vi.fn(),
  getPRReviews: vi.fn(),
  createCheckRun: vi.fn(),
  updateCheckRun: vi.fn(),
}));

vi.mock('./git.js', () => ({
  resolveBranchName: vi.fn().mockReturnValue('feature/42-fix'),
  resolveWorktreePath: vi.fn().mockReturnValue('/tmp/wts/42'),
  workerId: vi.fn().mockReturnValue('foundry-42'),
  fetchAll: vi.fn(),
  remoteBranchExists: vi.fn().mockReturnValue(false),
  worktreeExists: vi.fn().mockReturnValue(false),
  branchExists: vi.fn().mockReturnValue(false),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  push: vi.fn(),
  headSha: vi.fn().mockReturnValue('abc123'),
}));

vi.mock('./state.js', () => ({
  getRunnerId: vi.fn().mockReturnValue('test-runner'),
  getAllTasks: vi.fn().mockReturnValue([]),
  upsertTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  removeTask: vi.fn(),
  getLogDir: vi.fn().mockReturnValue('/tmp/logs/42'),
  getTaskStateDir: vi.fn().mockReturnValue('/tmp/state/42'),
}));

vi.mock('./claim.js', () => ({
  claimIssue: vi.fn().mockResolvedValue(true),
  claimIssueOnly: vi.fn().mockResolvedValue(true),
  markFailed: vi.fn(),
}));

vi.mock('./verify.js', () => ({
  runVerifyPipeline: vi.fn().mockReturnValue({ passed: true, results: [] }),
  parseAnnotations: vi.fn().mockReturnValue([]),
}));

vi.mock('./agent-output.js', () => ({
  formatInputRequestComment: vi.fn().mockReturnValue('Agent needs input'),
}));

vi.mock('./preview.js', () => ({
  previewUp: vi.fn(),
  previewDown: vi.fn(),
}));

vi.mock('./status-comment.js', () => ({
  updateStatusComment: vi.fn(),
}));

vi.mock('./log.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

// Mock the worker
const mockWorkerKill = vi.fn();
const mockWorkerSpawn = vi.fn().mockResolvedValue({
  id: 'foundry-42',
  isRunning: vi.fn().mockResolvedValue(true),
  kill: mockWorkerKill,
  getLogs: vi.fn().mockResolvedValue(''),
});
const mockWorkerHandleFor = vi.fn().mockReturnValue({
  id: 'foundry-42',
  isRunning: vi.fn().mockResolvedValue(true),
  kill: mockWorkerKill,
  getLogs: vi.fn().mockResolvedValue(''),
});

vi.mock('./workers/index.js', () => ({
  resolveWorker: vi.fn().mockReturnValue({
    name: 'subprocess',
    spawn: (...args: any[]) => mockWorkerSpawn(...args),
    handleFor: (...args: any[]) => mockWorkerHandleFor(...args),
  }),
}));

vi.mock('../backends/index.js', () => ({
  resolveBackend: vi.fn().mockReturnValue({
    name: 'command',
    resolveCommand: vi.fn().mockReturnValue('claude --task "work"'),
    resolveEnv: vi.fn().mockReturnValue({}),
  }),
  resolveBackendForIssue: vi.fn().mockReturnValue({
    name: 'command',
    resolveCommand: vi.fn().mockReturnValue('claude --task "work"'),
    resolveEnv: vi.fn().mockReturnValue({}),
  }),
}));

import * as github from './github.js';
import * as state from './state.js';
import * as claim from './claim.js';
import * as verify from './verify.js';
import { EventHandler } from './event-handler.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeConfig(): FoundryConfig {
  return {
    repo: 'owner/repo',
    labels: {
      ready: 'state:ready',
      in_progress: 'state:in-progress',
      done: 'state:done',
      ready_for_review: 'state:ready-for-human-review',
      waiting_for_input: 'state:waiting-for-input',
      failed: 'state:failed',
      plan_review: 'state:plan-review',
      claim: 'state:claim',
    },
    comment_triggers: {
      replan: '@foundry replan',
      restart: '@foundry restart',
      stop: '@foundry stop',
      continue: '@foundry continue',
      plan: '@foundry plan',
      start: '@foundry start',
      claim: '@foundry claim',
    },
    branch_template: 'feature/{issue}-{slug}',
    worktree_base: '../wts',
    max_input_rounds: 3,
    verify: [],
    integration_rebuild: '',
    version_sources: [],
    tag_prefix: 'v',
    default_agent_backend: 'command',
    agent_backends: {},
    github_backend: 'gh-cli',
  } as FoundryConfig;
}

function makeTask(overrides?: Partial<TaskState>): TaskState {
  return {
    issue: 42,
    title: 'Fix bug',
    repo: 'owner/repo',
    branch: 'feature/42-fix-bug',
    worktree: '/tmp/wts/42-fix-bug',
    tmux_session: 'foundry-42',
    agent_backend: 'command',
    status: 'agent-running',
    claimed_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    runner_id: 'test-runner',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('EventHandler', () => {
  let handler: EventHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new EventHandler(makeConfig(), '/tmp/repo');

    // Default mock returns for state.getAllTasks (used by status comment updates)
    vi.mocked(state.getAllTasks).mockReturnValue([]);
  });

  describe('command event: stop', () => {
    it('kills the worker and marks task as failed', async () => {
      const task = makeTask();

      await handler.handleEvent({
        type: 'command',
        task,
        command: 'stop',
        commentId: 1,
        commentAuthor: 'alice',
      });

      expect(mockWorkerHandleFor).toHaveBeenCalledWith('foundry-42');
      expect(mockWorkerKill).toHaveBeenCalled();
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'failed');
      // setStateLabel strips every other state label, then adds the target.
      expect(github.transitionLabels).toHaveBeenCalledWith(
        'owner/repo', 42,
        expect.arrayContaining(['state:in-progress', 'state:waiting-for-input', 'state:plan-review']),
        ['state:failed'],
        undefined,
      );
    });

    it('skips kill for claimed tasks (no agent running)', async () => {
      const task = makeTask({ status: 'claimed' });

      await handler.handleEvent({
        type: 'command',
        task,
        command: 'stop',
        commentId: 1,
        commentAuthor: 'alice',
      });

      expect(mockWorkerHandleFor).not.toHaveBeenCalled();
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'failed');
    });
  });

  describe('command event: continue', () => {
    it('resumes the agent', async () => {
      const task = makeTask({ status: 'waiting-for-input', session_id: 'sess-123' });

      await handler.handleEvent({
        type: 'command',
        task,
        command: 'continue',
        message: 'please fix the tests',
        commentId: 2,
        commentAuthor: 'alice',
      });

      // Should kill old session and spawn new one
      expect(mockWorkerKill).toHaveBeenCalled();
      expect(mockWorkerSpawn).toHaveBeenCalled();
    });
  });

  describe('issue_ready event', () => {
    it('claims the issue and spawns an agent', async () => {
      const event: FoundryEvent = {
        type: 'issue_ready',
        issue: {
          number: 10,
          title: 'New feature',
          body: 'Build it',
          labels: [{ name: 'state:ready' }],
          html_url: 'https://github.com/owner/repo/issues/10',
          state: 'open',
        },
      };

      await handler.handleEvent(event);

      expect(claim.claimIssue).toHaveBeenCalled();
      expect(mockWorkerSpawn).toHaveBeenCalled();
      expect(state.upsertTask).toHaveBeenCalled();
    });

    it('does nothing if claim fails', async () => {
      vi.mocked(claim.claimIssue).mockResolvedValueOnce(false);

      await handler.handleEvent({
        type: 'issue_ready',
        issue: {
          number: 10,
          title: 'New feature',
          body: 'Build it',
          labels: [{ name: 'state:ready' }],
          html_url: 'https://github.com/owner/repo/issues/10',
          state: 'open',
        },
      });

      expect(mockWorkerSpawn).not.toHaveBeenCalled();
      expect(state.upsertTask).not.toHaveBeenCalled();
    });
  });

  describe('pr_merged event', () => {
    it('marks the task as done and cleans up resources', async () => {
      const task = makeTask({ pr_url: 'https://github.com/owner/repo/pull/5' });

      await handler.handleEvent({
        type: 'pr_merged',
        task,
      });

      expect(github.transitionLabels).toHaveBeenCalledWith(
        'owner/repo', 42,
        expect.arrayContaining(['state:ready-for-human-review', 'state:in-progress']),
        ['state:done'],
        undefined,
      );
      expect(github.closeIssue).toHaveBeenCalledWith('owner/repo', 42);
      expect(state.removeTask).toHaveBeenCalledWith('owner/repo', 42);
    });
  });

  describe('agent_completed event: completed', () => {
    it('runs verification for completed outcome', async () => {
      const task = makeTask();
      const outcome: AgentOutcome = {
        type: 'completed',
        session_id: 'sess-1',
        final_message: 'Done!',
        ask_user_questions: null,
      };

      vi.mocked(verify.runVerifyPipeline).mockReturnValue({ passed: true, results: [] });
      vi.mocked(github.createPR).mockResolvedValue('https://github.com/owner/repo/pull/1');
      vi.mocked(github.extractPRNumber).mockReturnValue(1);

      await handler.handleEvent({
        type: 'agent_completed',
        task,
        outcome,
      });

      expect(verify.runVerifyPipeline).toHaveBeenCalled();
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'verifying');
    });
  });

  describe('agent_completed event: errored', () => {
    it('marks task as failed', async () => {
      const task = makeTask();
      const outcome: AgentOutcome = {
        type: 'errored',
        session_id: null,
        final_message: 'Something went wrong',
        ask_user_questions: null,
      };

      await handler.handleEvent({
        type: 'agent_completed',
        task,
        outcome,
      });

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'owner/repo', 42, 'failed',
        expect.objectContaining({ last_agent_message: 'Something went wrong' }),
      );
      expect(claim.markFailed).toHaveBeenCalledWith(expect.anything(), 42);
    });
  });

  describe('human_response event', () => {
    it('resumes the agent with the human response', async () => {
      const task = makeTask({ status: 'waiting-for-input', session_id: 'sess-abc' });

      await handler.handleEvent({
        type: 'human_response',
        task,
        response: 'Use the database approach',
      });

      expect(mockWorkerKill).toHaveBeenCalled();
      expect(mockWorkerSpawn).toHaveBeenCalled();
      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'owner/repo', 42, 'agent-running',
        expect.objectContaining({ permission_mode: '--dangerously-skip-permissions' }),
      );
    });
  });

  describe('pr_review event', () => {
    it('updates status and resumes agent with review feedback', async () => {
      const task = makeTask({ status: 'pr-open', session_id: 'sess-pr' });

      await handler.handleEvent({
        type: 'pr_review',
        task,
        feedback: 'Please fix the error handling in main.ts',
      });

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'owner/repo', 42, 'pr-changes-requested',
        expect.objectContaining({ last_agent_message: 'Please fix the error handling in main.ts' }),
      );
      // Should resume the agent
      expect(mockWorkerSpawn).toHaveBeenCalled();
    });
  });

  describe('issue_claim event', () => {
    it('claims the issue without spawning an agent', async () => {
      await handler.handleEvent({
        type: 'issue_claim',
        issue: {
          number: 15,
          title: 'Claimed issue',
          body: 'Just claim, no agent',
          labels: [{ name: 'state:claim' }],
          html_url: 'https://github.com/owner/repo/issues/15',
          state: 'open',
        },
      });

      expect(claim.claimIssueOnly).toHaveBeenCalled();
      expect(state.upsertTask).toHaveBeenCalled();

      // Verify the task was saved with 'claimed' status
      const savedTask = vi.mocked(state.upsertTask).mock.calls[0][1];
      expect(savedTask.status).toBe('claimed');
    });
  });

  describe('plan_approved event', () => {
    it('transitions labels and resumes agent', async () => {
      const task = makeTask({ status: 'plan-review', session_id: 'sess-plan' });

      await handler.handleEvent({
        type: 'plan_approved',
        task,
        response: 'Looks good, go ahead',
      });

      expect(github.transitionLabels).toHaveBeenCalledWith(
        'owner/repo', 42,
        expect.arrayContaining(['state:plan-review']),
        ['state:in-progress'],
        undefined,
      );
      expect(mockWorkerSpawn).toHaveBeenCalled();
    });
  });
});
