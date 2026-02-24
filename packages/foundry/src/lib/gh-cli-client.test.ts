/**
 * GhCliClient tests — mock execFileSync to verify correct argument passing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GhCliClient } from './gh-cli-client.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

const mockExec = vi.mocked(execFileSync);

describe('GhCliClient', () => {
  let client: GhCliClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GhCliClient();
  });

  describe('listIssuesByLabel', () => {
    it('calls gh with correct args and parses response', async () => {
      mockExec.mockReturnValue(JSON.stringify([
        { number: 1, title: 'Fix bug', body: 'desc', labels: [{ name: 'bug' }], url: 'https://github.com/o/r/issues/1', state: 'open' },
      ]));

      const result = await client.listIssuesByLabel('owner/repo', 'state:ready');

      expect(mockExec).toHaveBeenCalledWith('gh', [
        'issue', 'list',
        '--repo', 'owner/repo',
        '--label', 'state:ready',
        '--state', 'open',
        '--json', 'number,title,body,labels,url,state',
        '--limit', '50',
      ], expect.objectContaining({ encoding: 'utf-8' }));

      expect(result).toEqual([{
        number: 1,
        title: 'Fix bug',
        body: 'desc',
        labels: [{ name: 'bug' }],
        html_url: 'https://github.com/o/r/issues/1',
        state: 'open',
      }]);
    });

    it('handles empty body gracefully', async () => {
      mockExec.mockReturnValue(JSON.stringify([
        { number: 2, title: 'T', body: null, labels: [], url: 'https://github.com/o/r/issues/2', state: 'open' },
      ]));

      const result = await client.listIssuesByLabel('o/r', 'ready');
      expect(result[0].body).toBe('');
    });
  });

  describe('getIssue', () => {
    it('calls gh with correct args', async () => {
      mockExec.mockReturnValue(JSON.stringify({
        number: 5, title: 'T', body: 'B', labels: [{ name: 'a' }], url: 'https://github.com/o/r/issues/5', state: 'open',
      }));

      const result = await client.getIssue('o/r', 5);
      expect(mockExec).toHaveBeenCalledWith('gh', expect.arrayContaining(['issue', 'view', '5']), expect.anything());
      expect(result.number).toBe(5);
    });
  });

  describe('addLabel', () => {
    it('calls gh issue edit with --add-label', async () => {
      mockExec.mockReturnValue('');
      await client.addLabel('o/r', 1, 'bug');
      expect(mockExec).toHaveBeenCalledWith('gh', ['issue', 'edit', '1', '--repo', 'o/r', '--add-label', 'bug'], expect.anything());
    });
  });

  describe('removeLabel', () => {
    it('calls gh issue edit with --remove-label', async () => {
      mockExec.mockReturnValue('');
      await client.removeLabel('o/r', 1, 'bug');
      expect(mockExec).toHaveBeenCalledWith('gh', ['issue', 'edit', '1', '--repo', 'o/r', '--remove-label', 'bug'], expect.anything());
    });
  });

  describe('addComment', () => {
    it('calls gh issue comment', async () => {
      mockExec.mockReturnValue('');
      await client.addComment('o/r', 1, 'hello');
      expect(mockExec).toHaveBeenCalledWith('gh', ['issue', 'comment', '1', '--repo', 'o/r', '--body', 'hello'], expect.anything());
    });
  });

  describe('getComments', () => {
    it('calls gh api for issue comments', async () => {
      mockExec.mockReturnValue(JSON.stringify([
        { id: 1, body: 'hi', user: { login: 'bob' }, created_at: '2024-01-01T00:00:00Z' },
      ]));

      const result = await client.getComments('o/r', 5);
      expect(mockExec).toHaveBeenCalledWith('gh', ['api', 'repos/o/r/issues/5/comments', '--paginate'], expect.anything());
      expect(result).toHaveLength(1);
      expect(result[0].body).toBe('hi');
    });
  });

  describe('listLabels', () => {
    it('returns label names', async () => {
      mockExec.mockReturnValue(JSON.stringify([{ name: 'bug' }, { name: 'feature' }]));
      const result = await client.listLabels('o/r');
      expect(result).toEqual(['bug', 'feature']);
    });
  });

  describe('deleteLabel', () => {
    it('calls gh label delete', async () => {
      mockExec.mockReturnValue('');
      await client.deleteLabel('o/r', 'bug');
      expect(mockExec).toHaveBeenCalledWith('gh', ['label', 'delete', 'bug', '--repo', 'o/r', '--yes'], expect.anything());
    });
  });

  describe('ensureLabel', () => {
    it('calls gh label create with --force', async () => {
      mockExec.mockReturnValue('');
      await client.ensureLabel('o/r', 'bug', 'ff0000', 'Bug label');
      expect(mockExec).toHaveBeenCalledWith('gh',
        ['label', 'create', 'bug', '--repo', 'o/r', '--color', 'ff0000', '--description', 'Bug label', '--force'],
        expect.anything(),
      );
    });

    it('does not throw if label already exists', async () => {
      mockExec.mockImplementation(() => { throw new Error('already exists'); });
      await expect(client.ensureLabel('o/r', 'bug', 'ff0000', 'desc')).resolves.toBeUndefined();
    });
  });

  describe('createPR', () => {
    it('returns the PR URL', async () => {
      mockExec.mockReturnValue('https://github.com/o/r/pull/42');
      const url = await client.createPR('o/r', { title: 'T', body: 'B', head: 'feature', base: 'main' });
      expect(url).toBe('https://github.com/o/r/pull/42');
    });
  });

  describe('getPRStatus', () => {
    it('returns state and url', async () => {
      mockExec.mockReturnValue(JSON.stringify({ state: 'OPEN', url: 'https://github.com/o/r/pull/1' }));
      const result = await client.getPRStatus('o/r', 'feature');
      expect(result).toEqual({ state: 'OPEN', url: 'https://github.com/o/r/pull/1' });
    });

    it('returns null on error', async () => {
      mockExec.mockImplementation(() => { throw new Error('not found'); });
      const result = await client.getPRStatus('o/r', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getPRBranch', () => {
    it('returns the head branch name', async () => {
      mockExec.mockReturnValue(JSON.stringify({ headRefName: 'feature/42-fix' }));
      const branch = await client.getPRBranch('o/r', 42);
      expect(branch).toBe('feature/42-fix');
    });
  });

  describe('mergePR', () => {
    it('calls gh pr merge with default method', async () => {
      mockExec.mockReturnValue('');
      await client.mergePR('o/r', 42);
      expect(mockExec).toHaveBeenCalledWith('gh',
        ['pr', 'merge', '42', '--repo', 'o/r', '--merge', '--delete-branch'],
        expect.anything(),
      );
    });

    it('calls gh pr merge with rebase method', async () => {
      mockExec.mockReturnValue('');
      await client.mergePR('o/r', 42, 'rebase');
      expect(mockExec).toHaveBeenCalledWith('gh',
        ['pr', 'merge', '42', '--repo', 'o/r', '--rebase', '--delete-branch'],
        expect.anything(),
      );
    });
  });

  describe('isPRMergeable', () => {
    it('returns true when mergeable', async () => {
      mockExec.mockReturnValue(JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }));
      expect(await client.isPRMergeable('o/r', 1)).toBe(true);
    });

    it('returns false when not mergeable', async () => {
      mockExec.mockReturnValue(JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
      expect(await client.isPRMergeable('o/r', 1)).toBe(false);
    });

    it('returns false on error', async () => {
      mockExec.mockImplementation(() => { throw new Error('fail'); });
      expect(await client.isPRMergeable('o/r', 1)).toBe(false);
    });
  });

  describe('getPRReviews', () => {
    it('fetches reviews via gh pr view and comments via REST API', async () => {
      // First call: gh pr view --json reviews
      mockExec.mockReturnValueOnce(JSON.stringify({
        reviews: [{ author: { login: 'alice' }, state: 'APPROVED', body: 'lgtm', submittedAt: '2024-01-01T00:00:00Z' }],
      }));
      // Second call: gh api for review comments
      mockExec.mockReturnValueOnce(JSON.stringify([
        { user: { login: 'bob' }, body: 'fix this', created_at: '2024-01-01T01:00:00Z', path: 'src/main.ts', line: 42 },
      ]));

      const result = await client.getPRReviews('owner/repo', 5);

      expect(result.reviews).toHaveLength(1);
      expect(result.reviews[0].author.login).toBe('alice');
      expect(result.reviews[0].state).toBe('APPROVED');

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].author.login).toBe('bob');
      expect(result.comments[0].path).toBe('src/main.ts');
      expect(result.comments[0].line).toBe(42);

      // Verify the REST API call for review comments
      expect(mockExec).toHaveBeenCalledWith('gh',
        ['api', 'repos/owner/repo/pulls/5/comments', '--paginate'],
        expect.anything(),
      );
    });

    it('handles missing review comments gracefully', async () => {
      mockExec.mockReturnValueOnce(JSON.stringify({ reviews: [] }));
      mockExec.mockReturnValueOnce(JSON.stringify([]));

      const result = await client.getPRReviews('o/r', 1);
      expect(result.reviews).toHaveLength(0);
      expect(result.comments).toHaveLength(0);
    });
  });

  describe('commentOnPR', () => {
    it('calls gh pr comment', async () => {
      mockExec.mockReturnValue('');
      await client.commentOnPR('o/r', 1, 'feedback');
      expect(mockExec).toHaveBeenCalledWith('gh', ['pr', 'comment', '1', '--repo', 'o/r', '--body', 'feedback'], expect.anything());
    });
  });

  describe('updateComment', () => {
    it('calls gh api PATCH for comment update', async () => {
      mockExec.mockReturnValue('');
      await client.updateComment('o/r', 456, 'new body');
      expect(mockExec).toHaveBeenCalledWith('gh',
        ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/456', '-f', 'body=new body'],
        expect.anything(),
      );
    });
  });

  describe('closeIssue', () => {
    it('calls gh issue close', async () => {
      mockExec.mockReturnValue('');
      await client.closeIssue('o/r', 42);
      expect(mockExec).toHaveBeenCalledWith('gh', ['issue', 'close', '42', '--repo', 'o/r'], expect.anything());
    });
  });

  describe('closePR', () => {
    it('calls gh pr close', async () => {
      mockExec.mockReturnValue('');
      await client.closePR('o/r', 10);
      expect(mockExec).toHaveBeenCalledWith('gh', ['pr', 'close', '10', '--repo', 'o/r'], expect.anything());
    });

    it('accepts string PR identifier', async () => {
      mockExec.mockReturnValue('');
      await client.closePR('o/r', 'feature-branch');
      expect(mockExec).toHaveBeenCalledWith('gh', ['pr', 'close', 'feature-branch', '--repo', 'o/r'], expect.anything());
    });
  });

  describe('getRepoSlug', () => {
    it('returns the repo slug', async () => {
      mockExec.mockReturnValue('owner/repo');
      const slug = await client.getRepoSlug();
      expect(slug).toBe('owner/repo');
    });
  });
});
