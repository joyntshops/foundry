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
  updatePRBody: vi.fn(),
  closeIssue: vi.fn(),
  commentOnPR: vi.fn(),
  getComments: vi.fn().mockResolvedValue([]),
  updateComment: vi.fn(),
  extractPRNumber: vi.fn(),
  getPRReviews: vi.fn(),
  createCheckRun: vi.fn(),
  updateCheckRun: vi.fn(),
  getPR: vi.fn(),
}));

vi.mock('./task-recovery.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./task-recovery.js')>();
  return { issueNumberFromBranch: real.issueNumberFromBranch, recoverTask: vi.fn().mockResolvedValue(null) };
});

vi.mock('./issue-file.js', () => ({
  writeIssueFile: vi.fn().mockReturnValue({ FOUNDRY_ISSUE_FILE: '/tmp/state/42/issue.md' }),
}));

vi.mock('./preview-verify.js', () => ({
  isConfigured: vi.fn().mockReturnValue(false),
  verifyPreview: vi.fn().mockResolvedValue({ passed: true, url: 'https://pr-5.x', results: [] }),
  formatPreviewVerify: vi.fn().mockReturnValue('**Preview verification FAILED** against https://pr-5.x'),
}));

vi.mock('./stale-prs.js', () => ({
  handleStalePRs: vi.fn().mockResolvedValue([]),
  conflictInstruction: vi.fn().mockReturnValue('rebase please (PR #0 merged)'),
  dispatchCommand: vi.fn().mockReturnValue(true),
}));

vi.mock('./review.js', () => ({
  reviewAndMerge: vi.fn().mockResolvedValue({ merged: true, sha: 'newsha', rebased: true }),
}));

vi.mock('./worktree.js', () => ({
  preserveWork: vi.fn().mockReturnValue({ committed: false, pushed: true }),
  ensureWorktree: vi.fn(),
}));

vi.mock('./git.js', () => ({
  resolveBranchName: vi.fn().mockReturnValue('feature/42-fix'),
  resolveWorktreePath: vi.fn().mockReturnValue('/tmp/wts/42'),
  workerId: vi.fn().mockReturnValue('foundry-42'),
  fetchAll: vi.fn(),
  remoteBranchExists: vi.fn().mockImplementation((b: string) => b === 'integration' || b === 'test'),
  worktreeExists: vi.fn().mockReturnValue(false),
  branchExists: vi.fn().mockReturnValue(false),
  addWorktree: vi.fn(),
  addWorktreeTracking: vi.fn(),
  pruneWorktrees: vi.fn(),
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
  markFailed: vi.fn(),
}));

vi.mock('./thread.js', () => ({
  collectThread: vi.fn().mockResolvedValue([]),
}));

vi.mock('./verify.js', () => ({
  VERIFY_CHECK_NAME: 'Foundry Verification',
  runVerifyPipeline: vi.fn().mockReturnValue({ passed: true, results: [] }),
  parseAnnotations: vi.fn().mockReturnValue([]),
}));

vi.mock('./agent-output.js', () => ({
  formatInputRequestComment: vi.fn().mockReturnValue('Agent needs input'),
}));

vi.mock('./preview.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./preview.js')>();
  return {
    isOnDemand: real.isOnDemand,
    isExpired: real.isExpired,
    previewUp: vi.fn(),
    previewDown: vi.fn().mockResolvedValue(true),
    previewUpTarget: vi.fn().mockResolvedValue({ url: 'https://pr-40.x' }),
    previewDownTarget: vi.fn().mockResolvedValue(true),
    findPreviewUrlOnPR: vi.fn().mockResolvedValue('https://pr-40.x'),
    findPreviewOnPR: vi.fn().mockResolvedValue({ url: 'https://pr-40.x' }),
  };
});

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
import * as git from './git.js';
import * as worktree from './worktree.js';
import * as statusComment from './status-comment.js';
import * as issueFile from './issue-file.js';
import * as thread from './thread.js';
import * as previewMod from './preview.js';
import * as previewVerify from './preview-verify.js';
import * as stalePRs from './stale-prs.js';
import * as reviewMod from './review.js';
import * as state from './state.js';
import * as claim from './claim.js';
import * as verify from './verify.js';
import * as taskRecovery from './task-recovery.js';
import { EventHandler } from './event-handler.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeConfig(): FoundryConfig {
  return {
    repo: 'owner/repo',
    labels: {
      in_progress: 'state:in-progress',
      done: 'state:done',
      ready_for_review: 'state:ready-for-human-review',
      waiting_for_input: 'state:waiting-for-input',
      failed: 'state:failed',
      plan_review: 'state:plan-review',
    },
    comment_triggers: {
      go: '@foundry go',
      restart: '@foundry restart',
      stop: '@foundry stop',
      preview: '@foundry preview',
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

const ISSUE = { number: 42, title: 'Fix bug', body: 'Build it', labels: [] as Array<{ name: string }>, html_url: 'https://github.com/owner/repo/issues/42', state: 'open' };

function cmd(command: 'go' | 'restart' | 'stop' | 'preview', task: TaskState | null, message?: string): FoundryEvent {
  return { type: 'command', issue: 42, task, command, message, commentId: 1, commentAuthor: 'alice', via: 'comment' };
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

  describe('@foundry stop', () => {
    it('kills the worker, keeps the branch, marks the task failed', async () => {
      const task = makeTask();
      await handler.handleEvent(cmd('stop', task));

      expect(mockWorkerHandleFor).toHaveBeenCalledWith('foundry-42');
      expect(mockWorkerKill).toHaveBeenCalled();
      expect(worktree.preserveWork).toHaveBeenCalledWith(expect.anything(), task, expect.any(String), 'stopped');
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'failed');
      // setStateLabel strips every other state label, then adds the target.
      expect(github.transitionLabels).toHaveBeenCalledWith(
        'owner/repo', 42,
        expect.arrayContaining(['state:in-progress', 'state:waiting-for-input', 'state:plan-review']),
        ['state:failed'],
        undefined,
      );
      const msg = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2].message;
      expect(msg).toContain('`@foundry go` to continue from the branch');
    });

    it('does nothing on an issue that was never started', async () => {
      await handler.handleEvent(cmd('stop', null));
      expect(mockWorkerHandleFor).not.toHaveBeenCalled();
      expect(state.updateTaskStatus).not.toHaveBeenCalled();
      expect(github.transitionLabels).not.toHaveBeenCalled();
    });
  });

  describe('@foundry go', () => {
    beforeEach(() => {
      vi.mocked(github.getIssue).mockResolvedValue(ISSUE);
    });

    it('on an issue that was never started: claims it and spawns the agent', async () => {
      await handler.handleEvent(cmd('go', null));
      expect(github.getIssue).toHaveBeenCalledWith('owner/repo', 42);
      expect(claim.claimIssue).toHaveBeenCalled();
      expect(mockWorkerSpawn).toHaveBeenCalled();
      expect(state.upsertTask).toHaveBeenCalled();
      expect(mockWorkerSpawn.mock.calls.at(-1)![0].env.FOUNDRY_RESUME_CONTEXT).toBeUndefined();
    });

    it('cuts the worktree from the configured integration branch and opens the PR against it', async () => {
      const cfg = { ...makeConfig(), branches: { integration: 'test', production: 'main' } };
      const h = new EventHandler(cfg, '/tmp/repo');
      await h.handleEvent(cmd('go', null));
      expect(git.addWorktree).toHaveBeenCalledWith('/tmp/wts/42', 'feature/42-fix', 'origin/test', '/tmp/repo');
      vi.mocked(github.createPR).mockResolvedValue('https://github.com/owner/repo/pull/7');
      await h.handleEvent({ type: 'agent_completed', task: makeTask(), outcome: { type: 'completed', session_id: 's', final_message: 'ok', ask_user_questions: null, report: { status: 'done', summary: 'ok' } } });
      expect(github.createPR).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ base: 'test' }));
    });

    it('refuses to start, without claiming, when the integration branch is missing', async () => {
      const cfg = { ...makeConfig(), branches: { integration: 'nope', production: 'main' } };
      const h = new EventHandler(cfg, '/tmp/repo');
      await h.handleEvent(cmd('go', null));
      expect(claim.claimIssue).not.toHaveBeenCalled();
      expect(mockWorkerSpawn).not.toHaveBeenCalled();
      expect(github.addComment).toHaveBeenCalledWith('owner/repo', 42, expect.stringContaining('"nope" does not exist'));
    });

    it('does nothing if the claim fails', async () => {
      vi.mocked(claim.claimIssue).mockResolvedValueOnce(false);
      await handler.handleEvent(cmd('go', null));
      expect(mockWorkerSpawn).not.toHaveBeenCalled();
      expect(state.upsertTask).not.toHaveBeenCalled();
    });

    it('honours mode:plan on a fresh start', async () => {
      vi.mocked(github.getIssue).mockResolvedValue({ ...ISSUE, labels: [{ name: 'mode:plan' }] });
      await handler.handleEvent(cmd('go', null));
      const saved = vi.mocked(state.upsertTask).mock.calls[0][1];
      expect(saved.permission_mode).toBe('--permission-mode plan');
    });

    it('on a waiting task: relaunches from the branch with the reply as the answer', async () => {
      const task = makeTask({ status: 'waiting-for-input', last_agent_message: 'Tabs or a long form?' });
      await handler.handleEvent(cmd('go', task, 'Tabs.'));
      expect(worktree.ensureWorktree).toHaveBeenCalledWith(expect.anything(), task, expect.any(String));
      expect(mockWorkerKill).toHaveBeenCalled();
      expect(github.transitionLabels).toHaveBeenCalledWith('owner/repo', 42, expect.arrayContaining(['state:waiting-for-input']), ['state:in-progress'], undefined);
      const env = mockWorkerSpawn.mock.calls.at(-1)![0].env;
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('RESUMING issue #42 on branch feature/42-fix');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('Tabs or a long form?');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('Tabs.');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('do not start over');
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'agent-running', expect.objectContaining({ permission_mode: '--dangerously-skip-permissions' }));
    });

    it('on a plan-review task: tells the agent to implement', async () => {
      await handler.handleEvent(cmd('go', makeTask({ status: 'plan-review' }), 'Go ahead.'));
      expect(mockWorkerSpawn.mock.calls.at(-1)![0].env.FOUNDRY_RESUME_CONTEXT).toContain('implement it now');
    });

    it('on a failed task: resumes from the branch and points at the thread', async () => {
      await handler.handleEvent(cmd('go', makeTask({ status: 'failed' })));
      const env = mockWorkerSpawn.mock.calls.at(-1)![0].env;
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('`@foundry go`');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('(no message; see the thread in the issue file)');
      expect(claim.claimIssue).not.toHaveBeenCalled();
    });

    it('on an open PR: resumes with the PR named, without the review-round cap', async () => {
      const task = makeTask({ status: 'pr-open', pr_number: 5, pr_url: 'https://github.com/owner/repo/pull/5', input_request_count: 99 });
      await handler.handleEvent(cmd('go', task, 'Rename it.'));
      const env = mockWorkerSpawn.mock.calls.at(-1)![0].env;
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('pull request https://github.com/owner/repo/pull/5 is open');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('Rename it.');
      expect(claim.markFailed).not.toHaveBeenCalled();
    });

    it('on a task whose label still says running: the job is gone, so resume', async () => {
      await handler.handleEvent(cmd('go', makeTask({ status: 'agent-running' })));
      expect(mockWorkerSpawn).toHaveBeenCalled();
    });

    it('on a claim with no state label (after reset): starts fresh', async () => {
      await handler.handleEvent(cmd('go', makeTask({ status: 'claimed' })));
      expect(claim.claimIssue).toHaveBeenCalled();
    });
  });

  describe('@foundry restart', () => {
    beforeEach(() => {
      vi.mocked(github.getIssue).mockResolvedValue(ISSUE);
    });

    it('discards the task and starts it again in the same job', async () => {
      const task = makeTask({ status: 'failed' });
      await handler.handleEvent(cmd('restart', task));
      expect(state.removeTask).toHaveBeenCalledWith('owner/repo', 42);
      expect(claim.claimIssue).toHaveBeenCalled();
      expect(mockWorkerSpawn).toHaveBeenCalled();
      // the label is never set to anything a human would have to add
      for (const c of vi.mocked(github.transitionLabels).mock.calls) expect(c[3]).not.toContain('state:ready');
    });

    it('kills a running agent first', async () => {
      await handler.handleEvent(cmd('restart', makeTask({ status: 'agent-running' })));
      expect(mockWorkerKill).toHaveBeenCalled();
    });

    it('on an issue that was never started: same as go', async () => {
      await handler.handleEvent(cmd('restart', null));
      expect(state.removeTask).not.toHaveBeenCalled();
      expect(claim.claimIssue).toHaveBeenCalled();
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

    it('records the PR before the preview step, and a failure there is not "PR creation failed"', async () => {
      vi.mocked(verify.runVerifyPipeline).mockReturnValue({ passed: true, results: [] });
      vi.mocked(github.createPR).mockResolvedValue('https://github.com/owner/repo/pull/8');
      vi.mocked(github.extractPRNumber).mockReturnValue(8);
      // The preview verification is where a long deploy used to leave the
      // GitHub socket dead; here it throws the error that produced.
      vi.mocked(previewVerify.isConfigured).mockReturnValueOnce(true);
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ status: 'pr-open', pr_url: 'https://github.com/owner/repo/pull/8', pr_number: 8, preview_url: 'https://pr-8.x' })]);
      vi.mocked(previewVerify.verifyPreview).mockRejectedValueOnce(new Error('write EPIPE'));

      await handler.handleEvent({ type: 'agent_completed', task: makeTask(), outcome: {
        type: 'completed', session_id: 's', final_message: 'Done', ask_user_questions: null,
        report: { status: 'done', summary: 'Did it.' },
      } });

      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'pr-open', { pr_url: 'https://github.com/owner/repo/pull/8', pr_number: 8 });
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'failed');
      expect(claim.markFailed).toHaveBeenCalled();
      const last = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(last.historyEntry).toBe('Preview failed after PR');
      expect(last.prUrl).toBe('https://github.com/owner/repo/pull/8');
      expect(last.message).toContain('The PR is open');
      expect(last.message).toContain('write EPIPE');
      expect(last.message).not.toContain('PR creation failed');
    });

    it('reports a PR that could not be created as such', async () => {
      vi.mocked(verify.runVerifyPipeline).mockReturnValue({ passed: true, results: [] });
      vi.mocked(github.createPR).mockRejectedValueOnce(new Error('GraphQL: pull request creation is disabled'));
      await handler.handleEvent({ type: 'agent_completed', task: makeTask(), outcome: {
        type: 'completed', session_id: 's', final_message: 'Done', ask_user_questions: null,
        report: { status: 'done', summary: 'Did it.' },
      } });
      const last = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(last.historyEntry).toBe('PR creation failed');
      expect(state.updateTaskStatus).not.toHaveBeenCalledWith('owner/repo', 42, 'pr-open', expect.anything());
    });

    it('titles the PR with the issue number at the end, not as a leading "#N:"', async () => {
      vi.mocked(verify.runVerifyPipeline).mockReturnValue({ passed: true, results: [] });
      vi.mocked(github.createPR).mockResolvedValue('https://github.com/owner/repo/pull/43');
      vi.mocked(github.extractPRNumber).mockReturnValue(43);
      await handler.handleEvent({ type: 'agent_completed', task: makeTask(), outcome: {
        type: 'completed', session_id: 's', final_message: 'Done', ask_user_questions: null,
        report: { status: 'done', summary: 'Fixed it.' },
      } });
      expect(github.createPR).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ title: 'Fix bug (issue #42)' }));
    });

    it('rewrites the PR description from the latest report when the PR already exists', async () => {
      vi.mocked(verify.runVerifyPipeline).mockReturnValue({ passed: true, results: [] });
      await handler.handleEvent({ type: 'agent_completed', task: makeTask({ pr_url: 'https://github.com/owner/repo/pull/5', pr_number: 5 }), outcome: {
        type: 'completed', session_id: 's', final_message: 'Done', ask_user_questions: null,
        report: { status: 'done', summary: 'Second round: fixed the throttle.', assumptions: ['Kept the 30 s window for page opens.'] },
      } });
      expect(github.createPR).not.toHaveBeenCalled();
      const [repo, pr, body] = vi.mocked(github.updatePRBody).mock.calls[0];
      expect(repo).toBe('owner/repo');
      expect(pr).toBe(5);
      expect(body).toContain('Closes #42');
      expect(body).toContain('Second round: fixed the throttle.');
      expect(body).toContain('- Kept the 30 s window for page opens.');
    });
  });

  describe('agent_completed event: errored', () => {
    it('marks task as failed and keeps the branch', async () => {
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
      expect(worktree.preserveWork).toHaveBeenCalledWith(expect.anything(), task, expect.any(String), 'errored');
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

  describe('work survives the job', () => {
    it('needs-input pushes the branch before labelling and says so', async () => {
      const task = makeTask();
      await handler.handleEvent({ type: 'agent_completed', task, outcome: {
        type: 'needs-input', session_id: 's', final_message: 'Which?', ask_user_questions: [{ question: 'Which?', options: [], multiSelect: false }],
      } });
      expect(worktree.preserveWork).toHaveBeenCalledWith(expect.anything(), task, expect.any(String), 'waiting for input');
      const call = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(call.message).toMatch(/Work so far is on `feature\/42-fix/);
    });

    it('plan-completed pushes the branch', async () => {
      const task = makeTask();
      await handler.handleEvent({ type: 'agent_completed', task, outcome: {
        type: 'plan-completed', session_id: 's', final_message: '1. Do it', ask_user_questions: null,
      } });
      expect(worktree.preserveWork).toHaveBeenCalledWith(expect.anything(), task, expect.any(String), 'plan review');
    });

    it('verification failure pushes the branch and says so', async () => {
      vi.mocked(verify.runVerifyPipeline).mockReturnValueOnce({ passed: false, results: [{ command: 'npm test', success: false, output: 'boom', duration_ms: 1 }] } as any);
      const task = makeTask();
      await handler.handleEvent({ type: 'agent_completed', task, outcome: { type: 'completed', session_id: 's', final_message: 'ok', ask_user_questions: null, report: { status: 'done', summary: 'ok' } } });
      expect(worktree.preserveWork).toHaveBeenCalledWith(expect.anything(), task, expect.any(String), 'verification failed');
      const call = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(call.message).toMatch(/Work so far is on `feature\/42-fix/);
      expect(call.message).toContain('`@foundry go` to continue from the branch');
    });

    it('review feedback is framed as a review', async () => {
      const task = makeTask({ status: 'pr-open', pr_number: 5 });
      await handler.handleEvent({ type: 'pr_review', task, feedback: 'Rename the variable.' });
      expect(worktree.ensureWorktree).toHaveBeenCalled();
      const env = mockWorkerSpawn.mock.calls.at(-1)![0].env;
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('requested changes');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('Rename the variable.');
    });
  });

  describe('the issue is delivered as a file', () => {
    it('on first launch, from the fetched issue, with the thread so far', async () => {
      vi.mocked(github.getIssue).mockResolvedValue({ ...ISSUE, title: 'Add login', body: '## What\nA page.' });
      vi.mocked(thread.collectThread).mockResolvedValueOnce([{ author: 'alice', created_at: 't', body: 'Also dark mode.' }]);
      await handler.handleEvent(cmd('go', null));
      expect(issueFile.writeIssueFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        number: 42, title: 'Add login', body: '## What\nA page.', comments: [{ author: 'alice', created_at: 't', body: 'Also dark mode.' }],
      }));
      expect(mockWorkerSpawn.mock.calls.at(-1)![0].env.FOUNDRY_ISSUE_FILE).toBe('/tmp/state/42/issue.md');
    });

    it('on relaunch, from the body stored on the task', async () => {
      const task = makeTask({ status: 'waiting-for-input', issue_body: 'stored body' });
      await handler.handleEvent(cmd('go', task, 'ok'));
      expect(issueFile.writeIssueFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: 'stored body' }));
    });

    it('a thread that cannot be read does not block the launch', async () => {
      vi.mocked(thread.collectThread).mockRejectedValueOnce(new Error('api down'));
      await handler.handleEvent(cmd('go', makeTask({ status: 'failed' })));
      expect(issueFile.writeIssueFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ comments: [] }));
      expect(mockWorkerSpawn).toHaveBeenCalled();
    });
  });

  describe('pr_preview', () => {
    it('up deploys a preview for the PR with no task involved', async () => {
      await handler.handleEvent({ type: 'pr_preview', action: 'up', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' });
      expect(previewMod.previewUpTarget).toHaveBeenCalledWith(expect.anything(), { branch: 'integration', pr_number: 40, sha: 'deadbeef' });
      expect(mockWorkerSpawn).not.toHaveBeenCalled();
    });

    it('down finds the posted URL and tears the preview down', async () => {
      await handler.handleEvent({ type: 'pr_preview', action: 'down', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' });
      expect(previewMod.findPreviewUrlOnPR).toHaveBeenCalledWith('owner/repo', 40);
      expect(previewMod.previewDownTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pr_number: 40, preview_url: 'https://pr-40.x' }));
    });

    it('down with no posted URL does nothing', async () => {
      vi.mocked(previewMod.findPreviewUrlOnPR).mockResolvedValueOnce(undefined);
      await handler.handleEvent({ type: 'pr_preview', action: 'down', pr_number: 41, branch: 'integration', base: 'main', sha: 's' });
      expect(previewMod.previewDownTarget).not.toHaveBeenCalled();
    });
  });

  describe('preview verification gate', () => {
    const readyLabelSet = () => vi.mocked(github.transitionLabels).mock.calls.some(c => Array.isArray(c[3]) && c[3].includes('state:ready-for-human-review'));
    const completed = (task: any) => handler.handleEvent({ type: 'agent_completed', task, outcome: {
      type: 'completed', session_id: 's', final_message: 'done', ask_user_questions: null,
      report: { status: 'done', summary: 'done' },
    } });

    it('reports the verification check run only after the branch is pushed', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(false);
      vi.mocked(git.push).mockClear();
      vi.mocked(github.createCheckRun).mockClear();
      await completed(makeTask());
      expect(git.push).toHaveBeenCalled();
      expect(github.createCheckRun).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ name: 'Foundry Verification', head_sha: 'abc123', status: 'completed', conclusion: 'success' }));
      // GitHub rejects a check run for a commit it has not seen, so the push must come first.
      expect(vi.mocked(git.push).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(github.createCheckRun).mock.invocationCallOrder[0]);
    });

    it('when not configured, ready-for-review follows preview up with no verification', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(false);
      await completed(makeTask({ pr_url: 'https://github.com/owner/repo/pull/5', pr_number: 5 }));
      expect(previewVerify.verifyPreview).not.toHaveBeenCalled();
      expect(readyLabelSet()).toBe(true);
    });

    it('when it passes, the task is ready for review and the comment says so', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ pr_url: 'u', pr_number: 5, preview_url: 'https://pr-5.x', worktree: '/w' })]);
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));
      expect(previewVerify.verifyPreview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ url: 'https://pr-5.x', cwd: '/w' }));
      expect(readyLabelSet()).toBe(true);
      const last = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(last.historyEntry).toMatch(/preview verified/);
    });

    it('when it fails, the task is failed and never marked ready for review', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(previewVerify.verifyPreview).mockResolvedValueOnce({ passed: false, url: 'https://pr-5.x', results: [{ command: 'x', success: false, output: 'nope', duration_ms: 1 }] });
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ pr_url: 'u', pr_number: 5, preview_url: 'https://pr-5.x' })]);
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));
      expect(readyLabelSet()).toBe(false);
      expect(claim.markFailed).toHaveBeenCalled();
      const last = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(last.historyEntry).toBe('Preview verification failed');
    });

    it('when configured but no preview URL exists, it fails closed', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ pr_url: 'u', pr_number: 5, preview_url: undefined })]);
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));
      expect(previewVerify.verifyPreview).not.toHaveBeenCalled();
      expect(claim.markFailed).toHaveBeenCalled();
    });

    it('a non-task PR preview is verified from a throwaway checkout and reported on the PR', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(github.getComments).mockResolvedValue([]);
      await handler.handleEvent({ type: 'pr_preview', action: 'up', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' });
      expect(previewVerify.verifyPreview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ url: 'https://pr-40.x', cwd: expect.stringMatching(/pr-40$/) }));
      expect(github.commentOnPR).toHaveBeenCalledWith('owner/repo', 40, expect.stringContaining('foundry-preview-verify'));
      expect(github.createCheckRun).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ head_sha: 'deadbeef', conclusion: 'success' }));
    });
  });

  describe('after a merge', () => {
    it('checks sibling PRs for conflicts against the merged base', async () => {
      const task = makeTask({ pr_url: 'https://github.com/owner/repo/pull/5', pr_number: 5 });
      await handler.handleEvent({ type: 'pr_merged', task, base: 'integration' });
      expect(stalePRs.handleStalePRs).toHaveBeenCalledWith(expect.anything(), 'integration', 5);
      const h = new EventHandler({ ...makeConfig(), branches: { integration: 'test', production: 'main' } }, '/tmp/repo');
      await h.handleEvent({ type: 'pr_merged', task });
      expect(stalePRs.handleStalePRs).toHaveBeenLastCalledWith(expect.anything(), 'test', 5);
    });
  });

  describe('run usage', () => {
    it('is saved on the task when the outcome carries it', async () => {
      const task = makeTask();
      await handler.handleEvent({ type: 'agent_completed', task, outcome: {
        type: 'completed', session_id: 's', final_message: 'ok', ask_user_questions: null,
        report: { status: 'done', summary: 'ok' }, usage: { cost_usd: 0.5, turns: 9, duration_ms: 1000 },
      } });
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, task.status, expect.objectContaining({ last_run: { cost_usd: 0.5, turns: 9, duration_ms: 1000 } }));
    });

    it('every launch carries FOUNDRY_MAX_TURNS from config', async () => {
      vi.mocked(github.getIssue).mockResolvedValue(ISSUE);
      await handler.handleEvent(cmd('go', null));
      expect(mockWorkerSpawn.mock.calls.at(-1)![0].env.FOUNDRY_MAX_TURNS).toBe('150');
    });
  });

  describe('pr_approved', () => {
    it('reviews, merges, and completes the task in the same job', async () => {
      const task = makeTask({ pr_number: 9, pr_url: 'https://github.com/owner/repo/pull/9' });
      await handler.handleEvent({ type: 'pr_approved', pr_number: 9, branch: task.branch, base: 'integration', reviewer: 'alice', task });
      expect(reviewMod.reviewAndMerge).toHaveBeenCalledWith(expect.anything(), expect.any(String), { pr_number: 9, branch: task.branch, base: 'integration', reviewer: 'alice' });
      expect(github.closeIssue).toHaveBeenCalledWith('owner/repo', 42);
      expect(stalePRs.handleStalePRs).toHaveBeenCalledWith(expect.anything(), 'integration', 9);
    });

    it('a conflicting task PR is handed back to the agent', async () => {
      vi.mocked(reviewMod.reviewAndMerge).mockResolvedValueOnce({ merged: false, reason: 'conflicting', detail: 'x' });
      const task = makeTask({ pr_number: 9 });
      await handler.handleEvent({ type: 'pr_approved', pr_number: 9, branch: task.branch, base: 'integration', reviewer: 'alice', task });
      expect(stalePRs.dispatchCommand).toHaveBeenCalledWith(42, 'go', expect.stringContaining('rebase please'));
      expect(github.addComment).toHaveBeenCalledWith('owner/repo', 42, expect.stringContaining('approve again once it is clean'));
      expect(github.closeIssue).not.toHaveBeenCalled();
    });

    it('a merged promotion PR tears its preview down and checks siblings', async () => {
      await handler.handleEvent({ type: 'pr_approved', pr_number: 40, branch: 'integration', base: 'main', reviewer: 'alice' });
      expect(previewMod.findPreviewUrlOnPR).toHaveBeenCalledWith('owner/repo', 40);
      expect(stalePRs.handleStalePRs).toHaveBeenCalledWith(expect.anything(), 'main', 40);
    });

    it('failing checks stop everything', async () => {
      vi.mocked(reviewMod.reviewAndMerge).mockResolvedValueOnce({ merged: false, reason: 'checks_failed', detail: 'ci' });
      await handler.handleEvent({ type: 'pr_approved', pr_number: 40, branch: 'integration', base: 'main', reviewer: 'alice' });
      expect(previewMod.previewDownTarget).not.toHaveBeenCalled();
      expect(stalePRs.dispatchCommand).not.toHaveBeenCalled();
    });
  });

  // ── @foundry preview ────────────────────────────────────────────────

  describe('@foundry preview', () => {
    const PR = { number: 5, open: true, head: 'feature/42-fix-bug', base: 'integration', sha: 'cafe1234cafe', head_repo: 'owner/repo' };
    const previewConfig = (extra: object = {}): FoundryConfig => ({
      ...makeConfig(),
      preview: { mode: 'provider', up_command: 'deploy', down_command: 'destroy', ...extra },
    } as FoundryConfig);
    const taskWithPR = (o: Partial<TaskState> = {}) => makeTask({ status: 'pr-open', pr_number: 5, pr_url: 'https://github.com/owner/repo/pull/5', ...o });
    const lastReply = () => vi.mocked(github.addComment).mock.calls.at(-1)![2] as string;
    const stateLabelTouched = () => vi.mocked(github.transitionLabels).mock.calls.length > 0;

    beforeEach(() => {
      handler = new EventHandler(previewConfig(), '/tmp/repo');
      vi.mocked(github.getPR).mockReset().mockResolvedValue(PR);
      vi.mocked(github.getComments).mockResolvedValue([]);
      vi.mocked(previewVerify.isConfigured).mockReturnValue(false);
      vi.mocked(previewMod.previewUpTarget).mockResolvedValue({ url: 'https://pr-5.x', expiresAt: '2026-11-10T18:00:00.000Z' });
      vi.mocked(previewMod.previewDown).mockResolvedValue(true);
      vi.mocked(previewMod.previewDownTarget).mockResolvedValue(true);
      vi.mocked(previewMod.findPreviewOnPR).mockResolvedValue({ url: 'https://pr-40.x' });
      vi.mocked(taskRecovery.recoverTask).mockReset().mockResolvedValue(null);
    });

    it('deploys the open PR head, records it on the task, and answers on the issue', async () => {
      await handler.handleEvent(cmd('preview', taskWithPR()));

      expect(github.getPR).toHaveBeenCalledWith('owner/repo', 5);
      // The head comes from GitHub: this job has no worktree for the branch.
      expect(previewMod.previewUpTarget).toHaveBeenCalledWith(expect.anything(), { pr_number: 5, branch: 'feature/42-fix-bug', sha: 'cafe1234cafe', issue: 42 });
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'pr-open', { preview_url: 'https://pr-5.x', preview_expires_at: '2026-11-10T18:00:00.000Z', preview_pr_number: 5 });
      const reply = lastReply();
      expect(vi.mocked(github.addComment).mock.calls.at(-1)![1]).toBe(42);
      expect(reply).toContain('<!-- foundry-preview-reply -->');
      expect(reply).toContain('https://pr-5.x');
      expect(reply).toContain('`cafe123`');
      expect(reply).toContain('2026-11-10 18:00 UTC');
      expect(reply).toContain('`@foundry preview off`');
      // It is not a state transition and not an agent launch.
      expect(stateLabelTouched()).toBe(false);
      expect(mockWorkerSpawn).not.toHaveBeenCalled();
    });

    it('running it again deploys again (a respawn after an expiry, or a redeploy)', async () => {
      await handler.handleEvent(cmd('preview', taskWithPR()));
      await handler.handleEvent(cmd('preview', taskWithPR({ preview_url: undefined })));
      expect(previewMod.previewUpTarget).toHaveBeenCalledTimes(2);
      // Each explicit request starts a new clock: no expiry is carried over.
      expect(vi.mocked(previewMod.previewUpTarget).mock.calls[1][1]).not.toHaveProperty('expires_at');
    });

    it('runs verify_preview from a throwaway checkout and publishes the check on the PR head', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(previewVerify.verifyPreview).mockResolvedValueOnce({ passed: true, url: 'https://pr-5.x', results: [{ command: 'e2e', success: true, output: '', duration_ms: 1 }] });
      await handler.handleEvent(cmd('preview', taskWithPR()));

      expect(git.addWorktreeTracking).toHaveBeenCalledWith(expect.stringMatching(/pr-5$/), 'feature/42-fix-bug', '/tmp/repo');
      expect(previewVerify.verifyPreview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        url: 'https://pr-5.x', sha: 'cafe1234cafe', pr_number: 5,
        env: { FOUNDRY_BRANCH: 'feature/42-fix-bug', FOUNDRY_PR_NUMBER: '5', FOUNDRY_ISSUE: '42' },
      }));
      expect(github.createCheckRun).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ name: 'Foundry Preview Verification', head_sha: 'cafe1234cafe', conclusion: 'success' }));
      expect(github.commentOnPR).toHaveBeenCalledWith('owner/repo', 5, expect.stringContaining('foundry-preview-verify'));
      expect(lastReply()).toContain('Preview verification passed (1 check)');
    });

    it('a failed verification is reported and neither fails the task nor relaunches the agent', async () => {
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(previewVerify.verifyPreview).mockResolvedValueOnce({ passed: false, url: 'https://pr-5.x', results: [{ command: 'e2e', success: false, output: 'nope', duration_ms: 1 }] });
      await handler.handleEvent(cmd('preview', taskWithPR()));

      expect(github.createCheckRun).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ name: 'Foundry Preview Verification', conclusion: 'failure' }));
      expect(lastReply()).toContain('Preview verification failed');
      expect(lastReply()).toContain('`@foundry go <feedback>` on issue #42');
      expect(claim.markFailed).not.toHaveBeenCalled();
      expect(state.updateTaskStatus).not.toHaveBeenCalledWith('owner/repo', 42, 'failed');
      expect(stateLabelTouched()).toBe(false);
      expect(mockWorkerSpawn).not.toHaveBeenCalled();
      expect(stalePRs.dispatchCommand).not.toHaveBeenCalled();
    });

    it('says so when the task has no open pull request yet', async () => {
      await handler.handleEvent(cmd('preview', makeTask({ status: 'agent-running' })));
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
      expect(lastReply()).toContain('no open pull request for #42');
    });

    it('says so when the repository has no preview section, or the argument is unknown', async () => {
      handler = new EventHandler(makeConfig(), '/tmp/repo');
      await handler.handleEvent(cmd('preview', taskWithPR()));
      expect(lastReply()).toContain('needs a `preview` section');

      handler = new EventHandler(previewConfig(), '/tmp/repo');
      await handler.handleEvent(cmd('preview', taskWithPR(), 'now please'));
      expect(lastReply()).toContain('`now please` is not something it understands');
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
    });

    it('says so when no URL is produced, and records nothing', async () => {
      vi.mocked(previewMod.previewUpTarget).mockResolvedValueOnce(null);
      await handler.handleEvent(cmd('preview', taskWithPR()));
      expect(lastReply()).toContain('could not be deployed');
      expect(state.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('"off" tears the task\'s preview down and says how to bring it back', async () => {
      const task = taskWithPR({ preview_url: 'https://pr-5.x', preview_expires_at: '2026-11-10T18:00:00.000Z' });
      await handler.handleEvent(cmd('preview', task, 'off'));
      expect(previewMod.previewDown).toHaveBeenCalledWith(expect.anything(), task, 'off');
      expect(state.updateTaskStatus).toHaveBeenCalledWith('owner/repo', 42, 'pr-open', { preview_url: undefined, preview_expires_at: undefined });
      expect(lastReply()).toContain('torn down');
      expect(lastReply()).toContain('`@foundry preview` brings it back');
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
    });

    it('"off" with nothing up says so; a failed down command is not reported as torn down', async () => {
      await handler.handleEvent(cmd('preview', taskWithPR(), 'OFF'));
      expect(previewMod.previewDown).not.toHaveBeenCalled();
      expect(lastReply()).toContain('No preview is up for #42');

      vi.mocked(previewMod.previewDown).mockResolvedValueOnce(false);
      await handler.handleEvent(cmd('preview', taskWithPR({ preview_url: 'https://pr-5.x' }), 'off'));
      expect(lastReply()).toContain('may still be running');
      expect(state.updateTaskStatus).not.toHaveBeenCalled();
    });

    describe('typed on a pull request', () => {
      const onPR = (n: number, message?: string): FoundryEvent => ({ type: 'command', issue: n, task: null, command: 'preview', message, commentId: 1, commentAuthor: 'alice', via: 'comment' });

      it('a task\'s pull request resolves to the task through its branch and claim', async () => {
        vi.mocked(taskRecovery.recoverTask).mockResolvedValueOnce(taskWithPR());
        await handler.handleEvent(onPR(5));
        expect(taskRecovery.recoverTask).toHaveBeenCalledWith(expect.anything(), '/tmp/repo', 42);
        expect(previewMod.previewUpTarget).toHaveBeenCalledWith(expect.anything(), { pr_number: 5, branch: 'feature/42-fix-bug', sha: 'cafe1234cafe', issue: 42 });
        // The answer goes where the command was typed.
        expect(vi.mocked(github.addComment).mock.calls.at(-1)![1]).toBe(5);
      });

      it('a branch that only looks like a task\'s is not treated as one', async () => {
        // Issue 42 has a task, but on another branch: this PR is not its PR.
        vi.mocked(taskRecovery.recoverTask).mockResolvedValueOnce(taskWithPR({ branch: 'feature/42-the-real-one' }));
        await handler.handleEvent(onPR(5));
        expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
        expect(lastReply()).toContain('not a Foundry task\'s pull request');
      });

      it('a pull_request_bases pull request is previewed with no task', async () => {
        handler = new EventHandler(previewConfig({ pull_request_bases: ['main'] }), '/tmp/repo');
        vi.mocked(github.getPR).mockResolvedValue({ number: 40, open: true, head: 'integration', base: 'main', sha: 'deadbeef', head_repo: 'owner/repo' });
        await handler.handleEvent(onPR(40));
        expect(previewMod.previewUpTarget).toHaveBeenCalledWith(expect.anything(), { pr_number: 40, branch: 'integration', sha: 'deadbeef', issue: undefined });
        expect(state.updateTaskStatus).not.toHaveBeenCalled();

        await handler.handleEvent(onPR(40, 'off'));
        expect(previewMod.previewDownTarget).toHaveBeenCalledWith(expect.anything(), { branch: 'integration', pr_number: 40, sha: 'deadbeef', preview_url: 'https://pr-40.x' }, 'off');
      });

      it('any other pull request is refused', async () => {
        vi.mocked(github.getPR).mockResolvedValue({ number: 77, open: true, head: 'docs/readme', base: 'integration', sha: 's', head_repo: 'owner/repo' });
        await handler.handleEvent(onPR(77));
        expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
        expect(lastReply()).toContain('`integration` is not listed in `preview.pull_request_bases`');
      });

      it('a pull request from a fork is refused, even into a previewed base', async () => {
        handler = new EventHandler(previewConfig({ pull_request_bases: ['main'] }), '/tmp/repo');
        vi.mocked(github.getPR).mockResolvedValue({ number: 41, open: true, head: 'integration', base: 'main', sha: 's', head_repo: 'mallory/repo' });
        await handler.handleEvent(onPR(41));
        expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
        expect(taskRecovery.recoverTask).not.toHaveBeenCalled();
        expect(lastReply()).toContain('the fork `mallory/repo`');
      });

      it('a closed pull request has nothing to preview', async () => {
        vi.mocked(github.getPR).mockResolvedValue({ ...PR, open: false });
        await handler.handleEvent(onPR(5));
        expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
        expect(lastReply()).toContain('is closed');
      });

      it('a number that is neither a task nor a pull request says where the command goes', async () => {
        vi.mocked(github.getPR).mockRejectedValue(new Error('Not Found'));
        await handler.handleEvent(onPR(99));
        expect(lastReply()).toContain('#99 is not a Foundry task with an open pull request, and not a pull request');
      });
    });
  });

  // ── preview.trigger: on_demand ──────────────────────────────────────

  describe('preview.trigger: on_demand', () => {
    const onDemand = (extra: object = {}): FoundryConfig => ({
      ...makeConfig(),
      verify_preview: ['e2e'],
      preview: { mode: 'provider', up_command: 'deploy', trigger: 'on_demand', ...extra },
    } as FoundryConfig);
    const completed = (task: any) => handler.handleEvent({ type: 'agent_completed', task, outcome: {
      type: 'completed', session_id: 's', final_message: 'done', ask_user_questions: null,
      report: { status: 'done', summary: 'done' },
    } });
    const readyLabelSet = () => vi.mocked(github.transitionLabels).mock.calls.some(c => Array.isArray(c[3]) && c[3].includes('state:ready-for-human-review'));
    const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
    const PAST = new Date(Date.now() - 3_600_000).toISOString();

    beforeEach(() => {
      handler = new EventHandler(onDemand(), '/tmp/repo');
      vi.mocked(previewVerify.isConfigured).mockReturnValue(true);
      vi.mocked(previewMod.previewUpTarget).mockResolvedValue({ url: 'https://pr-5.x', expiresAt: FUTURE });
      vi.mocked(github.getComments).mockResolvedValue([]);
    });

    it('a finished task is ready for review on verify alone: nothing deploys, verify_preview gates nothing', async () => {
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ pr_url: 'u', pr_number: 5 })]);
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));

      expect(previewMod.previewUp).not.toHaveBeenCalled();
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
      expect(previewVerify.verifyPreview).not.toHaveBeenCalled();
      expect(claim.markFailed).not.toHaveBeenCalled();
      expect(readyLabelSet()).toBe(true);
      const last = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(last.message).toContain('Previews are on demand: comment `@foundry preview` on this issue');
    });

    it('a preview that is up follows the branch after an agent round, on the clock it already has', async () => {
      const live = makeTask({ pr_url: 'u', pr_number: 5, preview_url: 'https://pr-5.x', preview_expires_at: FUTURE, worktree: '/w' });
      vi.mocked(state.getAllTasks).mockReturnValue([live]);
      vi.mocked(previewVerify.verifyPreview).mockResolvedValueOnce({ passed: false, url: 'https://pr-5.x', results: [{ command: 'e2e', success: false, output: 'nope', duration_ms: 1 }] });
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));

      expect(previewMod.previewUpTarget).toHaveBeenCalledWith(expect.anything(), { pr_number: 5, branch: live.branch, sha: 'abc123', issue: 42, expires_at: FUTURE });
      // Verified in the task's own worktree (the branch is checked out there), reported, never gating.
      expect(previewVerify.verifyPreview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ url: 'https://pr-5.x', cwd: '/w' }));
      expect(git.addWorktreeTracking).not.toHaveBeenCalled();
      expect(github.createCheckRun).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ name: 'Foundry Preview Verification', conclusion: 'failure' }));
      expect(claim.markFailed).not.toHaveBeenCalled();
      expect(readyLabelSet()).toBe(true);
    });

    it('a preview past its expiry is not redeployed', async () => {
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ pr_url: 'u', pr_number: 5, preview_url: 'https://pr-5.x', preview_expires_at: PAST })]);
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
      expect(readyLabelSet()).toBe(true);
    });

    it('a pull_request_bases pull request deploys nothing on open or push while no preview is up', async () => {
      vi.mocked(previewMod.findPreviewOnPR).mockResolvedValueOnce(undefined);
      await handler.handleEvent({ type: 'pr_preview', action: 'up', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' });
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();

      vi.mocked(previewMod.findPreviewOnPR).mockResolvedValueOnce({ url: 'https://pr-40.x', expiresAt: PAST });
      await handler.handleEvent({ type: 'pr_preview', action: 'up', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' });
      expect(previewMod.previewUpTarget).not.toHaveBeenCalled();
    });

    it('a push redeploys a pull_request_bases preview that is up, keeping its expiry', async () => {
      vi.mocked(previewMod.findPreviewOnPR).mockResolvedValueOnce({ url: 'https://pr-40.x', expiresAt: FUTURE });
      await handler.handleEvent({ type: 'pr_preview', action: 'up', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' });
      expect(previewMod.previewUpTarget).toHaveBeenCalledWith(expect.anything(), { branch: 'integration', pr_number: 40, sha: 'deadbeef', expires_at: FUTURE });
    });

    it('with trigger auto (the default) the same config deploys and gates as before', async () => {
      handler = new EventHandler(onDemand({ trigger: 'auto' }), '/tmp/repo');
      vi.mocked(state.getAllTasks).mockReturnValue([makeTask({ pr_url: 'u', pr_number: 5, preview_url: 'https://pr-5.x', worktree: '/w' })]);
      await completed(makeTask({ pr_url: 'u', pr_number: 5 }));
      expect(previewMod.previewUp).toHaveBeenCalled();
      expect(previewVerify.verifyPreview).toHaveBeenCalled();
      const last = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(last.message).not.toContain('on demand');
    });
  });
});
