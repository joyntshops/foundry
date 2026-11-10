/**
 * Preview expiry against the mock GitHub client and real down commands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import { reapExpiredPreviews } from './preview-reaper.js';
import { buildPreviewComment, previewRecordFromComments } from './preview.js';
import type { FoundryConfig, GitHubComment } from '../types.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const PAST = '2026-11-10T11:00:00.000Z';
const FUTURE = '2026-11-10T13:00:00.000Z';

const config = (down_command = 'true', extra: object = {}): FoundryConfig => ({
  ...DEFAULTS, repo: 'o/r',
  preview: { mode: 'provider', down_command, ttl_hours: 4, ...extra },
});
const live = (id: number, url: string, expiresAt?: string): GitHubComment =>
  ({ id, body: buildPreviewComment({ url, state: 'active', sha: 'abc1234', expiresAt }), user: { login: 'foundry[bot]' }, created_at: '2026-11-10T08:00:00Z' }) as GitHubComment;
const CLAIM = '<!-- foundry-claim-block -->\n| Runner | `r` |\n| Branch | `feature/7-x` |\n| Worktree | `/w` |\n| Worker | `foundry-7` |\n| Agent Backend | `claude-code` |\n<!-- /foundry-claim-block -->';

let mock: MockGitHubClient;
let original: github.GitHubClient;
beforeEach(() => {
  original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock);
  mock.comments = [];
  mock.openPRs = [];
});
afterEach(() => { github.setClient(original); });

describe('reapExpiredPreviews', () => {
  it('tears down a preview past its expiry and rewrites its comment as expired', async () => {
    mock.openPRs = [{ number: 9, head: 'feature/7-x' }, { number: 10, head: 'feature/8-y' }, { number: 11, head: 'feature/9-z' }];
    mock.commentsByNumber[9] = [live(901, 'https://pr-9.x', PAST)];
    mock.commentsByNumber[10] = [live(902, 'https://pr-10.x', FUTURE)];
    mock.commentsByNumber[11] = [live(903, 'https://pr-11.x')];   // no expiry: lives until the PR closes
    // Issue 7 is a Foundry task on this branch, so the way back is its issue.
    mock.issue = { number: 7, title: 'x', body: '', labels: [], html_url: '', state: 'open' };
    mock.commentsByNumber[7] = [{ id: 1, body: CLAIM, user: { login: 'foundry[bot]' }, created_at: '2026-11-10T07:00:00Z' } as GitHubComment];
    mock.prs[9] = { number: 9, open: true, head: 'feature/7-x', base: 'integration', sha: 'cafe1234', head_repo: 'o/r' };

    const reaped = await reapExpiredPreviews(config(), '/w', NOW);

    expect(reaped).toEqual([{ pr_number: 9, branch: 'feature/7-x', url: 'https://pr-9.x', expiresAt: PAST, tornDown: true }]);
    const updates = mock.getCalls('updateComment');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[1]).toBe(901);
    const body: string = updates[0].args[2];
    expect(body).toContain('**Preview Environment** — Expired');
    expect(body).toContain('comment `@foundry preview` on issue #7 to bring it back');
    // Nothing reads back as live, so the next run leaves it alone and a respawn starts clean.
    expect(previewRecordFromComments([body])).toBeUndefined();
  });

  it('leaves the comment live when the down command fails, so the next run tries again', async () => {
    mock.openPRs = [{ number: 9, head: 'feature/7-x' }];
    mock.commentsByNumber[9] = [live(901, 'https://pr-9.x', PAST)];
    const reaped = await reapExpiredPreviews(config('false'), '/w', NOW);
    expect(reaped).toEqual([expect.objectContaining({ pr_number: 9, tornDown: false })]);
    expect(mock.getCalls('updateComment')).toHaveLength(0);
  });

  it('covers pull_request_bases pull requests, which have no issue', async () => {
    mock.listOpenPRs = async (_r, base) => base === 'main' ? [{ number: 40, head: 'integration' }] : [];
    mock.commentsByNumber[40] = [live(940, 'https://pr-40.x', PAST)];
    const reaped = await reapExpiredPreviews(config('true', { pull_request_bases: ['main'] }), '/w', NOW);
    expect(reaped).toEqual([expect.objectContaining({ pr_number: 40, tornDown: true })]);
    expect(mock.getCalls('updateComment')[0].args[2]).toContain('`issue=40` and `command=preview`');
  });

  it('does nothing without a preview section, with no open pull requests, or when nothing has expired', async () => {
    expect(await reapExpiredPreviews({ ...DEFAULTS, repo: 'o/r' }, '/w', NOW)).toEqual([]);
    expect(await reapExpiredPreviews(config(), '/w', NOW)).toEqual([]);
    mock.openPRs = [{ number: 10, head: 'feature/8-y' }];
    mock.commentsByNumber[10] = [live(902, 'https://pr-10.x', FUTURE)];
    expect(await reapExpiredPreviews(config(), '/w', NOW)).toEqual([]);
    expect(mock.getCalls('updateComment')).toHaveLength(0);
  });

  it('a failure to list one base does not stop the others', async () => {
    mock.listOpenPRs = async (_r, base) => {
      if (base === 'integration') throw new Error('boom');
      return [{ number: 40, head: 'integration' }];
    };
    mock.commentsByNumber[40] = [live(940, 'https://pr-40.x', PAST)];
    const reaped = await reapExpiredPreviews(config('true', { pull_request_bases: ['main'] }), '/w', NOW);
    expect(reaped.map(r => r.pr_number)).toEqual([40]);
  });
});
