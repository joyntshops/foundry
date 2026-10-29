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
}));

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
  runVerifyPipeline: vi.fn().mockReturnValue({ passed: true, results: [] }),
  parseAnnotations: vi.fn().mockReturnValue([]),
}));

vi.mock('./agent-output.js', () => ({
  formatInputRequestComment: vi.fn().mockReturnValue('Agent needs input'),
}));

vi.mock('./preview.js', () => ({
  previewUp: vi.fn(),
  previewDown: vi.fn(),
  previewUpTarget: vi.fn().mockResolvedValue({ url: 'https://pr-40.x' }),
  previewDownTarget: vi.fn(),
  findPreviewUrlOnPR: vi.fn().mockResolvedValue('https://pr-40.x'),
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

function cmd(command: 'go' | 'restart' | 'stop', task: TaskState | null, message?: string): FoundryEvent {
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
      expect(github.createCheckRun).toHaveBeenCalledWith('owner/repo', expect.objectContaining({ head_sha: 'abc123', status: 'completed', conclusion: 'success' }));
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
});
