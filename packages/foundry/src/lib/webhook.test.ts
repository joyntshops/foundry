/**
 * Webhook tests — signature verification and GitHub event mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webhookToEvents } from './webhook.js';
import type { FoundryConfig, TaskState } from '../types.js';

// Mock the state module so webhookToEvents can look up tasks
vi.mock('./state.js', () => ({
  getAllTasks: vi.fn().mockReturnValue([]),
}));

import * as state from './state.js';
const mockGetAllTasks = vi.mocked(state.getAllTasks);

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSignature(payload: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function makeConfig(overrides?: Partial<FoundryConfig>): FoundryConfig {
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
    ...overrides,
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

// ── webhookToEvents ──────────────────────────────────────────────────────

describe('webhookToEvents', () => {
  const config = makeConfig();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('issue_comment.created', () => {
    const comment = (body: string, extra: object = {}) => ({
      action: 'created',
      comment: { id: 100, body, user: { login: 'alice' }, ...extra },
      issue: { number: 42 },
    });

    it('maps "@foundry go <message>" to a go command with the message', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      const events = webhookToEvents('issue_comment', comment('@foundry go please fix the tests'), config);
      expect(events).toEqual([expect.objectContaining({
        type: 'command', issue: 42, command: 'go', message: 'please fix the tests', commentId: 100, commentAuthor: 'alice', via: 'comment',
      })]);
      expect((events[0] as any).task.issue).toBe(42);
    });

    it('takes the message from the following lines too', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      const events = webhookToEvents('issue_comment', comment('@foundry go\nUse tabs.\nAdd a test.'), config);
      expect((events[0] as any).message).toBe('Use tabs.\nAdd a test.');
    });

    it('a go command on an unclaimed issue carries a null task (fresh start)', () => {
      mockGetAllTasks.mockReturnValue([]);
      const events = webhookToEvents('issue_comment', comment('@foundry go'), config);
      expect(events).toEqual([expect.objectContaining({ type: 'command', issue: 42, task: null, command: 'go', message: undefined })]);
    });

    it('maps "@foundry restart" and "@foundry stop" (first line only)', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      expect((webhookToEvents('issue_comment', comment('@foundry stop'), config)[0] as any).command).toBe('stop');
      expect((webhookToEvents('issue_comment', comment('@foundry restart\nit went wrong'), config)[0] as any).command).toBe('restart');
      expect(webhookToEvents('issue_comment', comment('@foundry stop please'), config)).toEqual([]);
    });

    it('a plain comment is never an event, whatever the task state', () => {
      for (const status of ['waiting-for-input', 'plan-review', 'agent-running', 'failed'] as const) {
        mockGetAllTasks.mockReturnValue([makeTask({ status })]);
        expect(webhookToEvents('issue_comment', comment('Use the tabbed layout.'), config)).toEqual([]);
      }
    });

    it('a mention that is not at the start is just text', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      expect(webhookToEvents('issue_comment', comment('I think @foundry go is the answer'), config)).toEqual([]);
      expect(webhookToEvents('issue_comment', comment('@foundry gopher'), config)).toEqual([]);
    });

    it('ignores bot comments', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      expect(webhookToEvents('issue_comment', comment('@foundry go', { user: { login: 'foundry-bot[bot]' } }), config)).toEqual([]);
    });

    it('ignores comments on pull requests (their number is the PR, not the issue)', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      const payload = { ...comment('@foundry go'), issue: { number: 42, pull_request: { url: 'x' } } };
      expect(webhookToEvents('issue_comment', payload, config)).toEqual([]);
    });
  });

  describe('issues.labeled', () => {
    it('never starts anything: labels are status, not commands', () => {
      const events = webhookToEvents('issues', {
        action: 'labeled',
        label: { name: 'state:in-progress' },
        issue: { number: 10, title: 'New feature', body: 'Build something', labels: [], html_url: 'u', state: 'open' },
      }, config);
      expect(events).toEqual([]);
    });
  });

  describe('pull_request.closed', () => {
    it('maps merged PR to pr_merged event', () => {
      const task = makeTask({ branch: 'feature/42-fix-bug' });
      mockGetAllTasks.mockReturnValue([task]);

      const events = webhookToEvents('pull_request', {
        action: 'closed',
        pull_request: {
          merged: true,
          head: { ref: 'feature/42-fix-bug' },
        },
      }, config);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('pr_merged');
      if (events[0].type === 'pr_merged') {
        expect(events[0].task.issue).toBe(42);
      }
    });

    it('returns empty array for closed but not merged PR', () => {
      const events = webhookToEvents('pull_request', {
        action: 'closed',
        pull_request: {
          merged: false,
          head: { ref: 'feature/42-fix-bug' },
        },
      }, config);

      expect(events).toEqual([]);
    });

    it('returns empty array when no matching task for the branch', () => {
      mockGetAllTasks.mockReturnValue([]);

      const events = webhookToEvents('pull_request', {
        action: 'closed',
        pull_request: {
          merged: true,
          head: { ref: 'feature/unknown-branch' },
        },
      }, config);

      expect(events).toEqual([]);
    });
  });

  describe('pull_request previews for non-task PRs', () => {
    const cfg = makeConfig({ preview: { mode: 'template', url_template: 'https://pr-{pr_number}.x', pull_request_bases: ['main'] } });
    const promo = (action: string, extra: object = {}) => ({
      action,
      pull_request: { number: 40, merged: false, head: { ref: 'integration', sha: 'deadbeef' }, base: { ref: 'main' }, ...extra },
    });

    it.each(['opened', 'reopened', 'synchronize'])('%s on a listed base → pr_preview up', (action) => {
      mockGetAllTasks.mockReturnValue([]);
      expect(webhookToEvents('pull_request', promo(action), cfg)).toEqual([
        { type: 'pr_preview', action: 'up', pr_number: 40, branch: 'integration', base: 'main', sha: 'deadbeef' },
      ]);
    });

    it('closed on a listed base → pr_preview down, merged or not', () => {
      mockGetAllTasks.mockReturnValue([]);
      expect(webhookToEvents('pull_request', promo('closed'), cfg)[0]).toMatchObject({ type: 'pr_preview', action: 'down' });
      expect(webhookToEvents('pull_request', promo('closed', { merged: true }), cfg)[0]).toMatchObject({ type: 'pr_preview', action: 'down' });
    });

    it('ignores PRs whose base is not listed', () => {
      mockGetAllTasks.mockReturnValue([]);
      expect(webhookToEvents('pull_request', promo('opened', { base: { ref: 'integration' } }), cfg)).toEqual([]);
    });

    it('ignores non-task PRs when pull_request_bases is unset', () => {
      mockGetAllTasks.mockReturnValue([]);
      expect(webhookToEvents('pull_request', promo('opened'), config)).toEqual([]);
    });

    it('a task\'s own PR is never double-previewed, and still completes on merge', () => {
      mockGetAllTasks.mockReturnValue([makeTask({ branch: 'integration' })]);
      expect(webhookToEvents('pull_request', promo('synchronize'), cfg)).toEqual([]);
      expect(webhookToEvents('pull_request', promo('closed', { merged: true }), cfg)[0].type).toBe('pr_merged');
    });
  });

  describe('workflow_dispatch', () => {
    it('maps {issue, command, message} inputs to a dispatched command for the task', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      const events = webhookToEvents('workflow_dispatch', {
        inputs: { issue: '42', command: 'go', message: 'integration moved; rebase.' },
        sender: { login: 'foundry-bot[bot]' },
      }, config);
      expect(events).toEqual([expect.objectContaining({ type: 'command', issue: 42, command: 'go', message: 'integration moved; rebase.', via: 'dispatch' })]);
    });

    it('ignores unknown commands; an unknown issue is a fresh start', () => {
      mockGetAllTasks.mockReturnValue([makeTask()]);
      expect(webhookToEvents('workflow_dispatch', { inputs: { issue: '42', command: 'deploy' } }, config)).toEqual([]);
      expect(webhookToEvents('workflow_dispatch', { inputs: { issue: '42', command: 'continue' } }, config)).toEqual([]);
      expect(webhookToEvents('workflow_dispatch', { inputs: { issue: '99', command: 'go' } }, config)).toEqual([expect.objectContaining({ issue: 99, task: null })]);
    });
  });

  describe('pull_request_review.submitted', () => {
    it('maps changes_requested review to pr_review event', () => {
      const task = makeTask({ branch: 'feature/42-fix-bug' });
      mockGetAllTasks.mockReturnValue([task]);

      const events = webhookToEvents('pull_request_review', {
        action: 'submitted',
        review: {
          state: 'changes_requested',
          body: 'Please fix the error handling',
          user: { login: 'reviewer' },
        },
        pull_request: {
          head: { ref: 'feature/42-fix-bug' },
        },
      }, config);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('pr_review');
      if (events[0].type === 'pr_review') {
        expect(events[0].task.issue).toBe(42);
        expect(events[0].feedback).toContain('Please fix the error handling');
        expect(events[0].feedback).toContain('reviewer');
      }
    });

    it('maps an approved review on a task PR to pr_approved with the task', () => {
      const task = makeTask({ branch: 'feature/42-fix-bug' });
      mockGetAllTasks.mockReturnValue([task]);
      const events = webhookToEvents('pull_request_review', {
        action: 'submitted',
        review: { state: 'approved', body: 'LGTM', user: { login: 'reviewer' } },
        pull_request: { number: 9, head: { ref: 'feature/42-fix-bug' }, base: { ref: 'integration' } },
      }, config);
      expect(events).toEqual([expect.objectContaining({ type: 'pr_approved', pr_number: 9, branch: 'feature/42-fix-bug', base: 'integration', reviewer: 'reviewer', task: expect.objectContaining({ issue: 42 }) })]);
    });

    it('maps an approved review on a promotion PR to pr_approved without a task', () => {
      mockGetAllTasks.mockReturnValue([]);
      const cfg = makeConfig({ preview: { mode: 'template', url_template: 'u', pull_request_bases: ['main'] } });
      const events = webhookToEvents('pull_request_review', {
        action: 'submitted',
        review: { state: 'approved', user: { login: 'r' } },
        pull_request: { number: 40, head: { ref: 'integration' }, base: { ref: 'main' } },
      }, cfg);
      expect(events[0]).toMatchObject({ type: 'pr_approved', pr_number: 40, base: 'main' });
      expect((events[0] as any).task).toBeUndefined();
    });

    it('ignores approvals on PRs that are neither tasks nor promotion PRs, or when disabled', () => {
      mockGetAllTasks.mockReturnValue([]);
      const payload = { action: 'submitted', review: { state: 'approved', user: { login: 'r' } }, pull_request: { number: 1, head: { ref: 'x' }, base: { ref: 'integration' } } };
      expect(webhookToEvents('pull_request_review', payload, config)).toEqual([]);
      const task = makeTask({ branch: 'x' });
      mockGetAllTasks.mockReturnValue([task]);
      expect(webhookToEvents('pull_request_review', payload, makeConfig({ review: { merge_on_approval: false } }))).toEqual([]);
    });
  });

  describe('unknown events', () => {
    it('returns empty array for unknown event names', () => {
      const events = webhookToEvents('push', { ref: 'refs/heads/main' }, config);
      expect(events).toEqual([]);
    });

    it('returns empty array for unknown action', () => {
      const events = webhookToEvents('issues', { action: 'opened' }, config);
      expect(events).toEqual([]);
    });
  });
});
