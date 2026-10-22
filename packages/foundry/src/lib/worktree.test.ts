/**
 * preserveWork / ensureWorktree against real git repos: a bare "origin", a
 * clone acting as the job's checkout, and worktrees under it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preserveWork, ensureWorktree } from './worktree.js';
import * as git from './git.js';
import { DEFAULTS } from '../config.js';
import type { FoundryConfig, TaskState } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

let dir: string, origin: string, repo: string;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    issue: 42, title: 'T', repo: 'o/r', branch: 'feature/42-t', worktree: path.join(repo, 'wts', '42-t'),
    tmux_session: 'foundry-42', agent_backend: 'claude-code', status: 'agent-running',
    claimed_at: '', updated_at: '', runner_id: 'r', ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-wt-'));
  origin = path.join(dir, 'origin.git');
  repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'integration', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'pipe' });
  sh(repo, 'config', 'user.email', 't@example.test');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'checkout', '-q', '-b', 'integration');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'base'); sh(repo, 'push', '-q', '-u', 'origin', 'integration');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function makeWorktree(t: TaskState) {
  git.addWorktree(t.worktree, t.branch, 'origin/integration', repo);
  sh(t.worktree, 'config', 'user.email', 't@example.test');
  sh(t.worktree, 'config', 'user.name', 'T');
}

describe('preserveWork', () => {
  it('commits dirty changes and pushes when there is work', () => {
    const t = task(); makeWorktree(t);
    fs.writeFileSync(path.join(t.worktree, 'new.txt'), 'hello\n');

    const r = preserveWork(config, t, repo, 'waiting for input');

    expect(r).toEqual({ committed: true, pushed: true });
    expect(sh(repo, 'ls-remote', '--heads', 'origin', t.branch)).toContain(t.branch);
    expect(sh(t.worktree, 'log', '-1', '--format=%s')).toMatch(/work in progress \(waiting for input\)/);
  });

  it('pushes already-committed work without creating a commit', () => {
    const t = task(); makeWorktree(t);
    fs.writeFileSync(path.join(t.worktree, 'new.txt'), 'x\n');
    sh(t.worktree, 'add', '.'); sh(t.worktree, 'commit', '-q', '-m', 'agent work');

    expect(preserveWork(config, t, repo, 'r')).toEqual({ committed: false, pushed: true });
  });

  it('does nothing when there is nothing beyond the base', () => {
    const t = task(); makeWorktree(t);
    expect(preserveWork(config, t, repo, 'r')).toEqual({ committed: false, pushed: false });
    expect(sh(repo, 'ls-remote', '--heads', 'origin', t.branch)).toBe('');
  });

  it('does nothing when the worktree is gone', () => {
    expect(preserveWork(config, task(), repo, 'r')).toEqual({ committed: false, pushed: false });
  });
});

describe('ensureWorktree', () => {
  it('is a no-op when the worktree exists', () => {
    const t = task(); makeWorktree(t);
    const before = sh(t.worktree, 'rev-parse', 'HEAD');
    ensureWorktree(config, t, repo);
    expect(sh(t.worktree, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('recreates the worktree from the pushed branch in a fresh checkout', () => {
    const t = task(); makeWorktree(t);
    fs.writeFileSync(path.join(t.worktree, 'new.txt'), 'pushed\n');
    preserveWork(config, t, repo, 'r');
    const sha = sh(t.worktree, 'rev-parse', 'HEAD');

    // A new job: fresh clone, no worktree.
    const fresh = path.join(dir, 'fresh');
    execFileSync('git', ['clone', '-q', origin, fresh], { stdio: 'pipe' });
    const t2 = task({ worktree: path.join(fresh, 'wts', '42-t') });

    ensureWorktree(config, t2, fresh);

    expect(fs.existsSync(path.join(t2.worktree, 'new.txt'))).toBe(true);
    expect(sh(t2.worktree, 'rev-parse', 'HEAD')).toBe(sha);
    expect(sh(t2.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(t.branch);
    expect(sh(t2.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(`origin/${t.branch}`);
  });

  it('creates from the base branch when the branch was never pushed', () => {
    const t = task();
    ensureWorktree(config, t, repo);
    expect(fs.existsSync(path.join(t.worktree, 'a.txt'))).toBe(true);
    expect(sh(t.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(t.branch);
    expect(sh(t.worktree, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'origin/integration'));
  });

  it('survives a stale worktree registration whose directory is gone', () => {
    const t = task(); makeWorktree(t);
    fs.rmSync(t.worktree, { recursive: true, force: true });
    ensureWorktree(config, t, repo);
    expect(fs.existsSync(path.join(t.worktree, 'a.txt'))).toBe(true);
  });

  it('uses the configured integration branch as the base', () => {
    sh(repo, 'checkout', '-q', '-b', 'test');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'on test'); sh(repo, 'push', '-q', '-u', 'origin', 'test');
    const cfg = { ...config, branches: { integration: 'test', production: 'main' } };
    const t = task();
    ensureWorktree(cfg, t, repo);
    expect(fs.existsSync(path.join(t.worktree, 'b.txt'))).toBe(true);
    expect(sh(t.worktree, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'origin/test'));
  });

  it('refuses to create from a missing integration branch instead of falling back', () => {
    const cfg = { ...config, branches: { integration: 'nope', production: 'integration' } };
    expect(() => ensureWorktree(cfg, task(), repo)).toThrow(/"nope" does not exist/);
  });
});
