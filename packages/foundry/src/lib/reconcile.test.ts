import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import { parseStatusUpdatedAt, findStaleTasks, reconcile } from './reconcile.js';
import type { FoundryConfig } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r', reconcile_stale_minutes: 60 };
const NOW = new Date('2026-10-21T12:00:00Z');

const status = (updated: string) => `<!-- foundry-status -->\n### Status\n\n| Field | Value |\n|---|---|\n| Updated | ${updated} |\n\n<!-- /foundry-status -->`;
const CLAIM = '<!-- foundry-claim-block -->\n| Runner | `r` |\n| Branch | `feature/7-x` |\n| Worktree | `/w` |\n| Worker | `foundry-7` |\n| Agent Backend | `claude-code` |\n<!-- /foundry-claim-block -->';

let mock: MockGitHubClient;
let original: github.GitHubClient;
beforeEach(() => { original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock); });
afterEach(() => { github.setClient(original); });

describe('parseStatusUpdatedAt', () => {
  it('reads the Updated row', () => {
    expect(parseStatusUpdatedAt(status('2026-10-21 06:35:19 UTC'))?.toISOString()).toBe('2026-10-21T06:35:19.000Z');
  });
  it('is null without the row', () => {
    expect(parseStatusUpdatedAt('nothing here')).toBeNull();
  });
});

describe('findStaleTasks', () => {
  it('flags in-progress issues whose status is older than the threshold, and those with no status at all', async () => {
    mock.issues = [
      { number: 7, title: 'old', body: '', labels: [], html_url: '', state: 'open' },
      { number: 8, title: 'fresh', body: '', labels: [], html_url: '', state: 'open' },
      { number: 9, title: 'never started', body: '', labels: [], html_url: '', state: 'open' },
    ];
    mock.getComments = async (_r, issue) => {
      if (issue === 7) return [{ id: 1, body: status('2026-10-21 09:00:00 UTC'), user: { login: 'b' }, created_at: '' }] as any;
      if (issue === 8) return [{ id: 2, body: status('2026-10-21 11:30:00 UTC'), user: { login: 'b' }, created_at: '' }] as any;
      return [];
    };
    const stale = await findStaleTasks(config, NOW);
    expect(stale.map(s => s.issue)).toEqual([7, 9]);
    expect(stale[0].ageMinutes).toBe(180);
    expect(stale[1].lastUpdate).toBeNull();
    expect(mock.getCalls('listIssuesByLabel')).toEqual([{ method: 'listIssuesByLabel', args: ['o/r', 'state:in-progress'] }]);
  });
});

describe('reconcile', () => {
  it('marks a stale task failed with a note, using the recovered task', async () => {
    mock.issues = [{ number: 7, title: 'old', body: '', labels: [{ name: 'state:in-progress' }], html_url: '', state: 'open' }];
    mock.issue = mock.issues[0];
    mock.comments = [
      { id: 1, body: CLAIM, user: { login: 'b' }, created_at: '2026-10-21T08:00:00Z' },
      { id: 2, body: status('2026-10-21 09:00:00 UTC'), user: { login: 'b' }, created_at: '2026-10-21T09:00:00Z' },
    ] as any;
    const changed = await reconcile(config, '/repo', NOW);
    expect(changed.map(c => c.issue)).toEqual([7]);
    // in-progress removed, failed added
    const removed = mock.getCalls('removeLabel').map(c => c.args[2]);
    const added = mock.getCalls('addLabel').map(c => c.args[2]);
    expect(removed).toContain('state:in-progress');
    expect(added).toEqual(['state:failed']);
    // status comment updated in place
    expect(mock.getCalls('updateComment')).toHaveLength(1);
    expect(mock.getCalls('updateComment')[0].args[2]).toMatch(/no live run|is gone/);
  });

  it('does nothing when everything is fresh', async () => {
    mock.issues = [{ number: 8, title: 'fresh', body: '', labels: [], html_url: '', state: 'open' }];
    mock.comments = [{ id: 2, body: status('2026-10-21 11:59:00 UTC'), user: { login: 'b' }, created_at: '' }] as any;
    expect(await reconcile(config, '/repo', NOW)).toEqual([]);
    expect(mock.getCalls('addLabel')).toHaveLength(0);
  });
});
