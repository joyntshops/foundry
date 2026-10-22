import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import { threadFromComments, collectThread, isFoundryComment } from './thread.js';
import type { FoundryConfig, GitHubComment } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

const c = (id: number, login: string, body: string, created_at = `2026-01-0${id}T00:00:00Z`): GitHubComment =>
  ({ id, body, user: { login }, created_at });

describe('threadFromComments', () => {
  it('keeps human comments in order and drops Foundry and bot comments', () => {
    const out = threadFromComments(config, [
      c(3, 'bob', 'Third.'),
      c(1, 'alice', 'First.'),
      c(2, 'foundry[bot]', '<!-- foundry-status -->\nstatus'),
      c(4, 'alice', '<!-- foundry-claim-block -->\nposted via a human token'),
      c(5, 'github-actions[bot]', 'ci'),
    ]);
    expect(out.map(t => t.body)).toEqual(['First.', 'Third.']);
    expect(out[0]).toEqual({ author: 'alice', created_at: '2026-01-01T00:00:00Z', body: 'First.' });
  });

  it('keeps the message of a go command and drops a bare command', () => {
    const out = threadFromComments(config, [
      c(1, 'alice', '@foundry go'),
      c(2, 'alice', '@foundry go Use tabs.'),
      c(3, 'alice', '@foundry stop'),
      c(4, 'alice', '@foundry restart\nthe approach was wrong'),
      c(5, 'alice', '   '),
    ]);
    expect(out.map(t => t.body)).toEqual(['Use tabs.', 'the approach was wrong']);
  });

  it('isFoundryComment covers markers and bot logins', () => {
    expect(isFoundryComment(c(1, 'foundry[bot]', 'x'))).toBe(true);
    expect(isFoundryComment(c(1, 'alice', '<!-- foundry-preview -->'))).toBe(true);
    expect(isFoundryComment(c(1, 'alice', 'x'))).toBe(false);
  });
});

describe('collectThread', () => {
  let mock: MockGitHubClient;
  let original: github.GitHubClient;
  beforeEach(() => { original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock); });
  afterEach(() => { github.setClient(original); });

  it('fetches the issue comments and reduces them', async () => {
    mock.comments = [c(1, 'alice', 'Hi.'), c(2, 'foundry[bot]', 'status')];
    expect(await collectThread(config, 7)).toEqual([{ author: 'alice', created_at: '2026-01-01T00:00:00Z', body: 'Hi.' }]);
    expect(mock.getCalls('getComments')[0].args).toEqual(['o/r', 7]);
  });
});
