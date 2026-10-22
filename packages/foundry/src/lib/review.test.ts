/**
 * reviewAndMerge against a real bare origin plus the mock GitHub client.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import { reviewAndMerge, summariseChecks, awaitChecks } from './review.js';
import type { FoundryConfig } from '../types.js';

let dir: string, origin: string, repo: string, mock: MockGitHubClient, original: github.GitHubClient;
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
const config = (): FoundryConfig => ({ ...DEFAULTS, repo: 'o/r', worktree_base: './wts', review: { checks_timeout_seconds: 1 } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-review-'));
  origin = path.join(dir, 'origin.git'); repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'integration', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'pipe' });
  sh(repo, 'config', 'user.email', 't@x'); sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'checkout', '-q', '-b', 'integration');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'base'); sh(repo, 'push', '-q', '-u', 'origin', 'integration');
  // feature branch with one commit, then integration moves on (no conflict)
  sh(repo, 'checkout', '-q', '-b', 'feature/7-x'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'feature'); sh(repo, 'push', '-q', '-u', 'origin', 'feature/7-x');
  sh(repo, 'checkout', '-q', 'integration'); fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'moved'); sh(repo, 'push', '-q', 'origin', 'integration');
  original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock);
  mock.prMergeability = 'mergeable';
});
afterEach(() => { github.setClient(original); fs.rmSync(dir, { recursive: true, force: true }); });

describe('summariseChecks', () => {
  it('classifies', () => {
    expect(summariseChecks([{ name: 'ci', status: 'completed', conclusion: 'success' }]).state).toBe('success');
    expect(summariseChecks([{ name: 'ci', status: 'in_progress', conclusion: null }]).state).toBe('pending');
    expect(summariseChecks([{ name: 'ci', status: 'completed', conclusion: 'failure' }])).toMatchObject({ state: 'failure', failed: ['ci'] });
    expect(summariseChecks([{ name: 'foundry', status: 'in_progress', conclusion: null }], ['foundry']).state).toBe('success');
    expect(summariseChecks([{ name: 'x', status: 'completed', conclusion: 'skipped' }]).state).toBe('success');
  });
});

describe('awaitChecks', () => {
  it('polls while pending', async () => {
    let n = 0;
    mock.listCheckRuns = async () => { n++; return [{ name: 'ci', status: n < 3 ? 'queued' : 'completed', conclusion: n < 3 ? null : 'success' }]; };
    expect((await awaitChecks('o/r', 'sha', { timeoutMs: 2000, pollMs: 5 })).state).toBe('success');
    expect(n).toBe(3);
  });
});

describe('reviewAndMerge', () => {
  it('rebases a behind branch onto the base, pushes with lease, waits for checks, merges with the rebase method', async () => {
    mock.checkRuns = [{ name: 'ci', status: 'completed', conclusion: 'success' }];
    const before = sh(repo, 'rev-parse', 'origin/feature/7-x');
    const out = await reviewAndMerge(config(), repo, { pr_number: 9, branch: 'feature/7-x', base: 'integration', reviewer: 'alice' });
    expect(out.merged).toBe(true);
    if (!out.merged) return;
    expect(out.rebased).toBe(true);
    const after = sh(repo, 'rev-parse', 'origin/feature/7-x');
    expect(after).not.toBe(before);
    expect(after).toBe(out.sha);
    // linear: the rebased head's parent is integration's head
    expect(sh(repo, 'rev-parse', `${after}^`)).toBe(sh(repo, 'rev-parse', 'origin/integration'));
    expect(mock.getCalls('mergePR')).toEqual([{ method: 'mergePR', args: ['o/r', 9, 'rebase'] }]);
    expect(mock.getCalls('listCheckRuns')[0].args[1]).toBe(after);
    const comment = mock.getCalls('commentOnPR').at(-1)!.args[2];
    expect(comment).toContain('approved by @alice');
    expect(comment).toContain('Rebased onto `integration`');
    expect(comment).toContain('Merged into `integration`');
    expect(fs.existsSync(path.join(repo, 'wts', 'review-9'))).toBe(false);
  });

  it('stops on a conflict and says so on the PR', async () => {
    mock.prMergeability = 'conflicting';
    const out = await reviewAndMerge(config(), repo, { pr_number: 9, branch: 'feature/7-x', base: 'integration' });
    expect(out).toMatchObject({ merged: false, reason: 'conflicting' });
    expect(mock.getCalls('mergePR')).toHaveLength(0);
    expect(mock.getCalls('commentOnPR').at(-1)!.args[2]).toContain('conflicts with `integration`');
  });

  it('stops on failing checks without merging', async () => {
    mock.checkRuns = [{ name: 'ci', status: 'completed', conclusion: 'failure' }];
    const out = await reviewAndMerge(config(), repo, { pr_number: 9, branch: 'feature/7-x', base: 'integration' });
    expect(out).toMatchObject({ merged: false, reason: 'checks_failed', detail: 'ci' });
    expect(mock.getCalls('mergePR')).toHaveLength(0);
  });

  it('reports pending checks as a timeout, not a merge', async () => {
    mock.checkRuns = [{ name: 'ci', status: 'in_progress', conclusion: null }];
    const out = await reviewAndMerge(config(), repo, { pr_number: 9, branch: 'feature/7-x', base: 'integration' });
    expect(out).toMatchObject({ merged: false, reason: 'checks_timeout' });
  });

  it('does not push when already up to date', async () => {
    sh(repo, 'checkout', '-q', 'feature/7-x'); sh(repo, 'rebase', '-q', 'origin/integration'); sh(repo, 'push', '-q', '--force', 'origin', 'feature/7-x'); sh(repo, 'checkout', '-q', 'integration');
    mock.checkRuns = [];
    const out = await reviewAndMerge(config(), repo, { pr_number: 9, branch: 'feature/7-x', base: 'integration' });
    expect(out).toMatchObject({ merged: true, rebased: false });
    expect(mock.getCalls('commentOnPR').at(-1)!.args[2]).toContain('Already up to date');
  });
});
