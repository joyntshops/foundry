/**
 * Task recovery tests — rebuilding TaskState from GitHub with no local state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import {
  issueNumberFromBranch,
  issueNumberFromPayload,
  statusFromLabels,
  recoverTask,
} from './task-recovery.js';
import type { FoundryConfig } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

const CLAIM = [
  '<!-- foundry-claim-block -->',
  '**Foundry Claim**',
  '',
  '| Field | Value |',
  '|-------|-------|',
  '| Runner | `gha-123` |',
  '| Branch | `feature/42-add-login` |',
  '| Worktree | `/w/wts/42-add-login` |',
  '| Worker | `foundry-42` |',
  '| Agent Backend | `claude-code` |',
  '| Claimed At | 2026-09-02T10:00:00.000Z |',
  '<!-- /foundry-claim-block -->',
].join('\n');

describe('issueNumberFromBranch', () => {
  it('extracts the issue from the default template', () => {
    expect(issueNumberFromBranch('feature/{issue}-{slug}', 'feature/42-add-login')).toBe(42);
  });

  it('handles slugs with many hyphens', () => {
    expect(issueNumberFromBranch('feature/{issue}-{slug}', 'feature/7-a-b-c-d')).toBe(7);
  });

  it('returns null for branches that do not match', () => {
    expect(issueNumberFromBranch('feature/{issue}-{slug}', 'main')).toBeNull();
    expect(issueNumberFromBranch('feature/{issue}-{slug}', 'hotfix/42-x')).toBeNull();
  });

  it('honours custom templates with regex-special characters', () => {
    expect(issueNumberFromBranch('ai/issue.{issue}+{slug}', 'ai/issue.9+thing')).toBe(9);
  });
});

describe('issueNumberFromPayload', () => {
  it('prefers issue.number when present', () => {
    expect(issueNumberFromPayload({ issue: { number: 5 } }, config)).toBe(5);
  });

  it('parses the PR head branch', () => {
    const payload = { pull_request: { head: { ref: 'feature/42-add-login' }, body: '' } };
    expect(issueNumberFromPayload(payload, config)).toBe(42);
  });

  it('falls back to a Closes #N reference in the PR body', () => {
    const payload = { pull_request: { head: { ref: 'someone/manual' }, body: 'Fixes #17\n\nDetails.' } };
    expect(issueNumberFromPayload(payload, config)).toBe(17);
  });

  it('returns null when nothing identifies an issue', () => {
    expect(issueNumberFromPayload({ pull_request: { head: { ref: 'x' }, body: null } }, config)).toBeNull();
    expect(issueNumberFromPayload({}, config)).toBeNull();
  });
});

describe('statusFromLabels', () => {
  it('maps each state label to its status', () => {
    expect(statusFromLabels(config, ['state:ready-for-human-review'])).toBe('pr-open');
    expect(statusFromLabels(config, ['state:waiting-for-input'])).toBe('waiting-for-input');
    expect(statusFromLabels(config, ['state:plan-review'])).toBe('plan-review');
    expect(statusFromLabels(config, ['state:in-progress'])).toBe('agent-running');
    expect(statusFromLabels(config, ['state:claim'])).toBe('claimed');
    expect(statusFromLabels(config, ['state:failed'])).toBe('failed');
    expect(statusFromLabels(config, ['state:done'])).toBe('done');
  });

  it('returns null for untracked issues', () => {
    expect(statusFromLabels(config, ['state:ready', 'mode:plan'])).toBeNull();
    expect(statusFromLabels(config, [])).toBeNull();
  });
});

describe('recoverTask', () => {
  let mock: MockGitHubClient;
  let originalClient: github.GitHubClient;

  beforeEach(() => {
    originalClient = github.getClient();
    mock = new MockGitHubClient();
    github.setClient(mock);
    mock.issue = {
      number: 42, title: 'Add login', body: '', state: 'open',
      html_url: 'https://github.com/o/r/issues/42',
      labels: [{ name: 'state:ready-for-human-review' }, { name: 'mode:plan' }],
    };
  });

  afterEach(() => {
    github.setClient(originalClient);
  });

  it('returns null when the issue was never claimed', async () => {
    mock.comments = [{ id: 1, body: 'just chatter', user: { login: 'alice' }, created_at: '2026-09-02T09:00:00Z' } as any];
    expect(await recoverTask(config, '/w', 42)).toBeNull();
  });

  it('rebuilds the task from the claim comment, labels, PR, and preview comment', async () => {
    mock.comments = [
      { id: 1, body: CLAIM, user: { login: 'foundry[bot]' }, created_at: '2026-09-02T10:00:00Z' },
      { id: 2, body: '<!-- foundry-preview -->\n**Preview Environment** — Live\n\nPreview URL: https://pr-9.example.test\n', user: { login: 'foundry[bot]' }, created_at: '2026-09-02T10:30:00Z' },
    ] as any;
    mock.prStatus = { state: 'OPEN', url: 'https://github.com/o/r/pull/9' };

    const task = await recoverTask(config, '/w', 42);

    expect(task).not.toBeNull();
    expect(task!.issue).toBe(42);
    expect(task!.title).toBe('Add login');
    expect(task!.branch).toBe('feature/42-add-login');
    expect(task!.tmux_session).toBe('foundry-42');
    expect(task!.agent_backend).toBe('claude-code');
    expect(task!.runner_id).toBe('gha-123');
    expect(task!.status).toBe('pr-open');
    expect(task!.permission_mode).toBe('--permission-mode plan');
    expect(task!.pr_url).toBe('https://github.com/o/r/pull/9');
    expect(task!.pr_number).toBe(9);
    expect(task!.preview_url).toBe('https://pr-9.example.test');
    expect(task!.worktree).toBe('/w/wts/42-add-login');
    expect(task!.claimed_at).toBe('2026-09-02T10:00:00Z');
  });

  it('uses the most recent claim when the issue was re-claimed', async () => {
    const older = CLAIM.replace('gha-123', 'gha-old');
    mock.comments = [
      { id: 1, body: older, user: { login: 'b' }, created_at: '2026-09-01T10:00:00Z' },
      { id: 2, body: CLAIM, user: { login: 'b' }, created_at: '2026-09-02T10:00:00Z' },
    ] as any;
    mock.prStatus = null;

    const task = await recoverTask(config, '/w', 42);
    expect(task!.runner_id).toBe('gha-123');
    expect(task!.pr_url).toBeUndefined();
    expect(task!.preview_url).toBeUndefined();
  });

  it('still parses claim comments written before the Worker row rename', async () => {
    const legacy = CLAIM.replace('| Worker |', '| tmux Session |');
    mock.comments = [{ id: 1, body: legacy, user: { login: 'b' }, created_at: '2026-09-02T10:00:00Z' }] as any;
    const task = await recoverTask(config, '/w', 42);
    expect(task!.tmux_session).toBe('foundry-42');
  });

  it('skips the issue fetch when the issue is provided', async () => {
    mock.comments = [{ id: 1, body: CLAIM, user: { login: 'b' }, created_at: '2026-09-02T10:00:00Z' }] as any;
    await recoverTask(config, '/w', 42, mock.issue);
    expect(mock.getCalls('getIssue')).toHaveLength(0);
  });
});
