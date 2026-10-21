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
    it('maps "@foundry continue" comment to a command event', () => {
      const task = makeTask();
      mockGetAllTasks.mockReturnValue([task]);

      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: {
          id: 100,
          body: '@foundry continue please fix the tests',
          user: { login: 'alice' },
        },
        issue: { number: 42 },
      }, config);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('command');
      if (events[0].type === 'command') {
        expect(events[0].command).toBe('continue');
        expect(events[0].message).toBe('please fix the tests');
        expect(events[0].commentId).toBe(100);
        expect(events[0].commentAuthor).toBe('alice');
      }
    });

    it('maps "@foundry stop" comment to a command event', () => {
      const task = makeTask();
      mockGetAllTasks.mockReturnValue([task]);

      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: {
          id: 101,
          body: '@foundry stop',
          user: { login: 'bob' },
        },
        issue: { number: 42 },
      }, config);

      expect(events).toHaveLength(1);
      if (events[0].type === 'command') {
        expect(events[0].command).toBe('stop');
      }
    });

    it('returns empty array for comments without @foundry trigger', () => {
      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: {
          id: 102,
          body: 'This is a regular comment',
          user: { login: 'alice' },
        },
        issue: { number: 42 },
      }, config);

      expect(events).toEqual([]);
    });

    it('maps a plain reply on a waiting-for-input issue to human_response', () => {
      mockGetAllTasks.mockReturnValue([makeTask({ status: 'waiting-for-input' })]);
      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: { id: 103, body: 'Use the tabbed layout.', user: { login: 'alice' } },
        issue: { number: 42 },
      }, config);
      expect(events).toEqual([{ type: 'human_response', task: expect.objectContaining({ issue: 42 }), response: 'Use the tabbed layout.' }]);
    });

    it('maps a plain reply on a plan-review issue to plan_approved', () => {
      mockGetAllTasks.mockReturnValue([makeTask({ status: 'plan-review' })]);
      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: { id: 104, body: 'Looks good, go ahead.', user: { login: 'alice' } },
        issue: { number: 42 },
      }, config);
      expect(events[0].type).toBe('plan_approved');
    });

    it('an @foundry command on a waiting issue is still a command', () => {
      mockGetAllTasks.mockReturnValue([makeTask({ status: 'waiting-for-input' })]);
      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: { id: 105, body: '@foundry restart', user: { login: 'alice' } },
        issue: { number: 42 },
      }, config);
      expect(events[0].type).toBe('command');
    });

    it('ignores plain comments on a task that is not waiting', () => {
      mockGetAllTasks.mockReturnValue([makeTask({ status: 'agent-running' })]);
      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: { id: 106, body: 'Any update?', user: { login: 'alice' } },
        issue: { number: 42 },
      }, config);
      expect(events).toEqual([]);
    });

    it('returns empty array for bot comments', () => {
      const task = makeTask();
      mockGetAllTasks.mockReturnValue([task]);

      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: {
          id: 103,
          body: '@foundry continue',
          user: { login: 'foundry-bot[bot]' },
        },
        issue: { number: 42 },
      }, config);

      expect(events).toEqual([]);
    });

    it('returns empty array when no matching task exists', () => {
      mockGetAllTasks.mockReturnValue([]);

      const events = webhookToEvents('issue_comment', {
        action: 'created',
        comment: {
          id: 104,
          body: '@foundry continue',
          user: { login: 'alice' },
        },
        issue: { number: 99 },
      }, config);

      expect(events).toEqual([]);
    });
  });

  describe('issues.labeled', () => {
    it('maps state:ready label to issue_ready event', () => {
      const events = webhookToEvents('issues', {
        action: 'labeled',
        label: { name: 'state:ready' },
        issue: {
          number: 10,
          title: 'New feature',
          body: 'Build something',
          labels: [{ name: 'state:ready' }],
          html_url: 'https://github.com/owner/repo/issues/10',
          state: 'open',
        },
      }, config);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('issue_ready');
      if (events[0].type === 'issue_ready') {
        expect(events[0].issue.number).toBe(10);
        expect(events[0].issue.title).toBe('New feature');
      }
    });

    it('maps state:claim label to issue_claim event', () => {
      const events = webhookToEvents('issues', {
        action: 'labeled',
        label: { name: 'state:claim' },
        issue: {
          number: 11,
          title: 'Claimed task',
          body: null,
          labels: [{ name: 'state:claim' }],
          html_url: 'https://github.com/owner/repo/issues/11',
          state: 'open',
        },
      }, config);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('issue_claim');
    });

    it('returns empty array for unrelated labels', () => {
      const events = webhookToEvents('issues', {
        action: 'labeled',
        label: { name: 'bug' },
        issue: {
          number: 12,
          title: 'Bug',
          body: '',
          labels: [{ name: 'bug' }],
          html_url: 'https://github.com/owner/repo/issues/12',
          state: 'open',
        },
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

    it('returns empty array for approved reviews', () => {
      const task = makeTask({ branch: 'feature/42-fix-bug' });
      mockGetAllTasks.mockReturnValue([task]);

      const events = webhookToEvents('pull_request_review', {
        action: 'submitted',
        review: {
          state: 'approved',
          body: 'LGTM',
          user: { login: 'reviewer' },
        },
        pull_request: {
          head: { ref: 'feature/42-fix-bug' },
        },
      }, config);

      expect(events).toEqual([]);
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
