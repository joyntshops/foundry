/**
 * Tests for runReset — dry-run vs force, missing resources, no task found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before importing the module under test
vi.mock('../config.js', () => ({
  loadConfigSafe: vi.fn(),
}));
vi.mock('../lib/state.js', () => ({
  getAllTasks: vi.fn(),
  removeTask: vi.fn(),
  listTaskIssueNumbers: vi.fn(),
}));
vi.mock('../lib/tmux.js', () => ({
  sessionExists: vi.fn(),
  killSession: vi.fn(),
}));
vi.mock('../lib/git.js', () => ({
  repoRoot: vi.fn(),
  worktreeExists: vi.fn(),
  removeWorktree: vi.fn(),
  branchExists: vi.fn(),
  deleteBranch: vi.fn(),
  remoteBranchExists: vi.fn(),
  deleteRemoteBranch: vi.fn(),
}));
vi.mock('../lib/github.js', () => ({
  getIssue: vi.fn(),
  getPRStatus: vi.fn(),
  closePR: vi.fn(),
  removeLabel: vi.fn(),
  addLabel: vi.fn(),
  closeIssue: vi.fn(),
  transitionLabels: vi.fn(),
}));
vi.mock('../lib/claim.js', () => ({
  markFailed: vi.fn(),
}));
vi.mock('../lib/preview.js', () => ({
  previewDown: vi.fn(),
}));
vi.mock('../lib/log.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
}));

import { runReset } from './sessions.js';
import { loadConfigSafe } from '../config.js';
import * as state from '../lib/state.js';
import * as tmux from '../lib/tmux.js';
import * as git from '../lib/git.js';
import * as github from '../lib/github.js';
import * as log from '../lib/log.js';
import type { FoundryConfig, TaskState } from '../types.js';

const mockConfig: FoundryConfig = {
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
  branch_template: 'feature/{issue}-{slug}',
  worktree_base: './wts',
  tmux_template: 'foundry-{issue}',
  max_sessions: 4,
  max_verify_parallel: 1,
  max_input_rounds: 3,
  verify: [],
  integration_rebuild: '',
  comment_triggers: { replan: '@foundry replan', restart: '@foundry restart' },
  version_sources: [],
  tag_prefix: 'v',
  default_agent_backend: 'command',
  agent_backends: {},
  poll_interval_seconds: 30,
  github_backend: 'gh-cli',
};

const mockTask: TaskState = {
  issue: 42,
  title: 'Fix the thing',
  repo: 'owner/repo',
  branch: 'feature/42-fix-the-thing',
  worktree: '/tmp/wts/42-fix-the-thing',
  tmux_session: 'foundry-42',
  agent_backend: 'command',
  agent_command: 'echo hello',
  status: 'pr-open',
  claimed_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  runner_id: 'test-runner',
  pr_url: 'https://github.com/owner/repo/pull/10',
  pr_number: 10,
};

describe('runReset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfigSafe).mockReturnValue(mockConfig);
    vi.mocked(git.repoRoot).mockReturnValue('/repo');
  });

  it('errors when no config found', async () => {
    vi.mocked(loadConfigSafe).mockReturnValue(null);
    await runReset('42', {});
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining('No config found'));
  });

  it('errors when task not found', async () => {
    vi.mocked(state.getAllTasks).mockReturnValue([]);
    await runReset('42', {});
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining('No task found'));
  });

  it('errors on invalid issue number', async () => {
    await runReset('abc', {});
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining('Invalid issue'));
  });

  describe('dry-run (no --force)', () => {
    beforeEach(() => {
      vi.mocked(state.getAllTasks).mockReturnValue([mockTask]);
      vi.mocked(tmux.sessionExists).mockReturnValue(true);
      vi.mocked(git.worktreeExists).mockReturnValue(true);
      vi.mocked(git.branchExists).mockReturnValue(true);
      vi.mocked(git.remoteBranchExists).mockReturnValue(true);
      vi.mocked(github.getPRStatus).mockResolvedValue({ state: 'OPEN', url: 'https://github.com/owner/repo/pull/10' });
    });

    it('does not mutate any resources', async () => {
      await runReset('42', {});

      // Nothing should be called
      expect(tmux.killSession).not.toHaveBeenCalled();
      expect(git.removeWorktree).not.toHaveBeenCalled();
      expect(git.deleteBranch).not.toHaveBeenCalled();
      expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
      expect(github.closePR).not.toHaveBeenCalled();
      expect(github.transitionLabels).not.toHaveBeenCalled();
      expect(state.removeTask).not.toHaveBeenCalled();
    });

    it('logs what would happen', async () => {
      await runReset('42', {});
      const infoCalls = vi.mocked(log.info).mock.calls.map(c => c[0]);
      expect(infoCalls.some(m => m.includes('Dry-run'))).toBe(true);
      expect(infoCalls.some(m => m.includes('would'))).toBe(true);
    });
  });

  describe('--force', () => {
    beforeEach(() => {
      vi.mocked(state.getAllTasks).mockReturnValue([mockTask]);
      vi.mocked(tmux.sessionExists).mockReturnValue(true);
      vi.mocked(git.worktreeExists).mockReturnValue(true);
      vi.mocked(git.branchExists).mockReturnValue(true);
      vi.mocked(git.remoteBranchExists).mockReturnValue(true);
      vi.mocked(github.getPRStatus).mockResolvedValue({ state: 'OPEN', url: 'https://github.com/owner/repo/pull/10' });
      vi.mocked(github.transitionLabels).mockResolvedValue();
      vi.mocked(github.closePR).mockResolvedValue();
    });

    it('executes all cleanup steps', async () => {
      await runReset('42', { force: true });

      expect(tmux.killSession).toHaveBeenCalledWith('foundry-42');
      expect(git.removeWorktree).toHaveBeenCalledWith('/tmp/wts/42-fix-the-thing', '/repo');
      expect(git.deleteBranch).toHaveBeenCalledWith('feature/42-fix-the-thing', '/repo');
      expect(git.deleteRemoteBranch).toHaveBeenCalledWith('feature/42-fix-the-thing', '/repo');
      expect(github.closePR).toHaveBeenCalledWith('owner/repo', 10);
      // transitionLabels called with all state labels to remove and ready to add
      expect(github.transitionLabels).toHaveBeenCalledWith(
        'owner/repo', 42,
        ['state:in-progress', 'state:waiting-for-input', 'state:failed', 'state:done', 'state:ready-for-human-review'],
        ['state:ready'],
      );
      expect(state.removeTask).toHaveBeenCalledWith('owner/repo', 42);
    });
  });

  describe('with missing resources', () => {
    beforeEach(() => {
      vi.mocked(state.getAllTasks).mockReturnValue([{
        ...mockTask,
        pr_url: undefined,
        pr_number: undefined,
      }]);
      vi.mocked(tmux.sessionExists).mockReturnValue(false);
      vi.mocked(git.worktreeExists).mockReturnValue(false);
      vi.mocked(git.branchExists).mockReturnValue(false);
      vi.mocked(git.remoteBranchExists).mockReturnValue(false);
      vi.mocked(github.transitionLabels).mockResolvedValue();
    });

    it('gracefully skips missing resources', async () => {
      await runReset('42', { force: true });

      // These should NOT be called
      expect(tmux.killSession).not.toHaveBeenCalled();
      expect(git.removeWorktree).not.toHaveBeenCalled();
      expect(git.deleteBranch).not.toHaveBeenCalled();
      expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
      expect(github.closePR).not.toHaveBeenCalled();

      // transitionLabels still called (it handles the label filtering internally)
      expect(github.transitionLabels).toHaveBeenCalledWith(
        'owner/repo', 42,
        ['state:in-progress', 'state:waiting-for-input', 'state:failed', 'state:done', 'state:ready-for-human-review'],
        ['state:ready'],
      );
      expect(state.removeTask).toHaveBeenCalledWith('owner/repo', 42);
    });
  });
});
