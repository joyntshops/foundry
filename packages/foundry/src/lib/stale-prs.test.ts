import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import {
  conflictInstruction, awaitMergeability, findStalePRs, currentWorkflowFile, dispatchCommand, handleStalePRs,
} from './stale-prs.js';
import type { FoundryConfig } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

let mock: MockGitHubClient;
let original: github.GitHubClient;
beforeEach(() => { original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock); });
afterEach(() => { github.setClient(original); delete process.env.GITHUB_WORKFLOW_REF; });

describe('conflictInstruction', () => {
  it('names the base and the merged PR and allows rebase', () => {
    const t = conflictInstruction('integration', 29);
    expect(t).toContain('`integration` has moved (PR #29 merged)');
    expect(t).toContain('Rebase onto `origin/integration`');
  });
});

describe('awaitMergeability', () => {
  it('returns immediately when known', async () => {
    mock.prMergeability = 'conflicting';
    expect(await awaitMergeability('o/r', 5, 1000, 10)).toBe('conflicting');
    expect(mock.getCalls('getPRMergeability')).toHaveLength(1);
  });

  it('polls while unknown, then returns the resolved state', async () => {
    let calls = 0;
    mock.getPRMergeability = async (repo, pr) => { calls++; return calls < 3 ? 'unknown' : 'mergeable'; };
    expect(await awaitMergeability('o/r', 5, 1000, 5)).toBe('mergeable');
    expect(calls).toBe(3);
  });

  it('gives up as unknown at the deadline', async () => {
    mock.prMergeability = 'unknown';
    expect(await awaitMergeability('o/r', 5, 30, 5)).toBe('unknown');
  });
});

describe('findStalePRs', () => {
  it('returns only Foundry PRs that conflict, skipping the merged one and non-task branches', async () => {
    mock.openPRs = [
      { number: 10, head: 'feature/40-a' },
      { number: 11, head: 'feature/41-b' },
      { number: 12, head: 'release/1.2' },
    ];
    const checked: number[] = [];
    mock.getPRMergeability = async (_r, pr) => { checked.push(pr); return pr === 11 ? 'conflicting' : 'mergeable'; };
    const stale = await findStalePRs(config, 'integration', 10);
    expect(stale).toEqual([{ pr_number: 11, branch: 'feature/41-b', issue: 41 }]);
    expect(mock.getCalls('listOpenPRs')).toEqual([{ method: 'listOpenPRs', args: ['o/r', 'integration'] }]);
    // The merged PR and the non-task branch were never checked.
    expect(checked).toEqual([11]);
  });
});

describe('currentWorkflowFile', () => {
  it('parses GITHUB_WORKFLOW_REF', () => {
    process.env.GITHUB_WORKFLOW_REF = 'o/r/.github/workflows/foundry.yml@refs/heads/integration';
    expect(currentWorkflowFile()).toBe('foundry.yml');
  });
  it('is null outside Actions', () => {
    expect(currentWorkflowFile()).toBeNull();
  });
});

describe('dispatchCommand', () => {
  it('returns false and does not shell out when there is no workflow to dispatch', () => {
    expect(dispatchCommand(41, 'continue', 'x')).toBe(false);
  });
});

describe('handleStalePRs', () => {
  it('notes the conflict on each issue, with the manual fallback when dispatch is impossible', async () => {
    mock.openPRs = [{ number: 11, head: 'feature/41-b' }];
    mock.prMergeability = 'conflicting';
    const stale = await handleStalePRs(config, 'integration', 10);
    expect(stale).toHaveLength(1);
    const note = mock.getCalls('addComment')[0];
    expect(note.args[1]).toBe(41);
    expect(note.args[2]).toContain('PR #11 now conflicts');
    expect(note.args[2]).toContain('@foundry continue');
  });

  it('is quiet when nothing conflicts', async () => {
    mock.openPRs = [{ number: 11, head: 'feature/41-b' }];
    mock.prMergeability = 'mergeable';
    expect(await handleStalePRs(config, 'integration', 10)).toEqual([]);
    expect(mock.getCalls('addComment')).toHaveLength(0);
  });

  it('never throws when the listing fails', async () => {
    mock.errors.set('listOpenPRs', new Error('boom'));
    expect(await handleStalePRs(config, 'integration', 10)).toEqual([]);
  });
});
