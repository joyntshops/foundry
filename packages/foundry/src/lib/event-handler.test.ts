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
  remoteBranchExists: vi.fn().mockReturnValue(false),
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
import * as worktree from './worktree.js';
import * as statusComment from './status-comment.js';
import * as issueFile from './issue-file.js';
import * as previewMod from './preview.js';
import * as previewVerify from './preview-verify.js';
import * as stalePRs from './stale-prs.js';
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

  describe('work survives the job', () => {
    it('needs-input pushes the branch before labelling and says so', async () => {
      const task = makeTask();
      await handler.handleEvent({ type: 'agent_completed', task, outcome: {
        type: 'needs-input', session_id: 's', final_message: 'Which?', ask_user_questions: [{ question: 'Which?', options: [], multiSelect: false }],
      } });
      expect(worktree.preserveWork).toHaveBeenCalledWith(task, expect.any(String), 'waiting for input');
      const call = vi.mocked(statusComment.updateStatusComment).mock.calls.at(-1)![2];
      expect(call.message).toMatch(/Work so far is on `feature\/42-fix/);
    });

    it('plan-completed pushes the branch', async () => {
      const task = makeTask();
      await handler.handleEvent({ type: 'agent_completed', task, outcome: {
        type: 'plan-completed', session_id: 's', final_message: '1. Do it', ask_user_questions: null,
      } });
      expect(worktree.preserveWork).toHaveBeenCalledWith(task, expect.any(String), 'plan review');
    });

    it('a human reply recreates the worktree and relaunches with the exchange in the environment', async () => {
      const task = makeTask({ status: 'waiting-for-input', last_agent_message: 'Tabs or a long form?' });
      await handler.handleEvent({ type: 'human_response', task, response: 'Tabs.' });
      expect(worktree.ensureWorktree).toHaveBeenCalledWith(task, expect.any(String));
      const env = mockWorkerSpawn.mock.calls.at(-1)![0].env;
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('RESUMING issue #42 on branch feature/42-fix');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('Tabs or a long form?');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('Tabs.');
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('do not start over');
    });

    it('plan approval tells the agent to implement', async () => {
      const task = makeTask({ status: 'plan-review' });
      await handler.handleEvent({ type: 'plan_approved', task, response: 'Go ahead.' });
      const env = mockWorkerSpawn.mock.calls.at(-1)![0].env;
      expect(env.FOUNDRY_RESUME_CONTEXT).toContain('implement it now');
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
    it('on first launch, from the issue payload', async () => {
      const issue = { number: 42, title: 'Add login', body: '## What\nA page.', html_url: 'u', state: 'open', labels: [] as any[] };
      await handler.handleEvent({ type: 'issue_ready', issue });
      expect(issueFile.writeIssueFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ number: 42, title: 'Add login', body: '## What\nA page.' }));
      expect(mockWorkerSpawn.mock.calls.at(-1)![0].env.FOUNDRY_ISSUE_FILE).toBe('/tmp/state/42/issue.md');
    });

    it('on relaunch, from the body stored on the task', async () => {
      const task = makeTask({ status: 'waiting-for-input', issue_body: 'stored body' });
      await handler.handleEvent({ type: 'human_response', task, response: 'ok' });
      expect(issueFile.writeIssueFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: 'stored body' }));
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
    });
  });
});
