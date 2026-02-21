/**
 * Git & worktree operations
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env },
  }).trim();
}

function gitSafe(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

// ── Branch operations ───────────────────────────────────────────────────

export function currentBranch(cwd?: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export function branchExists(branch: string, cwd?: string): boolean {
  return gitSafe(['rev-parse', '--verify', branch], cwd) !== null;
}

export function remoteBranchExists(branch: string, cwd?: string): boolean {
  return gitSafe(['rev-parse', '--verify', `origin/${branch}`], cwd) !== null;
}

export function fetchAll(cwd?: string): void {
  git(['fetch', '--all', '--prune'], cwd);
}

export function checkout(branch: string, cwd?: string): void {
  git(['checkout', branch], cwd);
}

export function createBranch(branch: string, base: string, cwd?: string): void {
  git(['checkout', '-b', branch, base], cwd);
}

export function push(branch: string, cwd?: string, force = false): void {
  const args = ['push', '-u', 'origin', branch];
  if (force) args.splice(1, 0, '--force-with-lease');
  git(args, cwd);
}

export function rebase(onto: string, cwd?: string): void {
  git(['rebase', onto], cwd);
}

export function merge(branch: string, cwd?: string, noFf = false): void {
  const args = ['merge', branch];
  if (noFf) args.push('--no-ff');
  git(args, cwd);
}

export function tag(name: string, message: string, cwd?: string): void {
  git(['tag', '-a', name, '-m', message], cwd);
}

export function pushTag(name: string, cwd?: string): void {
  git(['push', 'origin', name], cwd);
}

// ── Worktree operations ─────────────────────────────────────────────────

export function addWorktree(worktreePath: string, branch: string, base: string, cwd?: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '-b', branch, worktreePath, base], cwd);
}

export function removeWorktree(worktreePath: string, cwd?: string): void {
  gitSafe(['worktree', 'remove', worktreePath, '--force'], cwd);
}

export function listWorktrees(cwd?: string): Array<{ path: string; branch: string }> {
  const raw = git(['worktree', 'list', '--porcelain'], cwd);
  const entries: Array<{ path: string; branch: string }> = [];
  let current: Partial<{ path: string; branch: string }> = {};

  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === '') {
      if (current.path && current.branch) {
        entries.push({ path: current.path, branch: current.branch });
      }
      current = {};
    }
  }
  if (current.path && current.branch) {
    entries.push({ path: current.path, branch: current.branch });
  }
  return entries;
}

export function worktreeExists(worktreePath: string, cwd?: string): boolean {
  return listWorktrees(cwd).some(w => w.path === worktreePath);
}

// ── Utility ─────────────────────────────────────────────────────────────

export function repoRoot(cwd?: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function resolveBranchName(template: string, issue: number, title: string): string {
  return template
    .replace('{issue}', String(issue))
    .replace('{slug}', slugify(title));
}

export function resolveWorktreePath(base: string, issue: number, title: string, repoDir: string): string {
  const name = `${issue}-${slugify(title)}`;
  return path.resolve(repoDir, base, name);
}

export function resolveTmuxName(template: string, issue: number): string {
  return template.replace('{issue}', String(issue));
}

export function getLatestTag(prefix: string, cwd?: string): string | null {
  const raw = gitSafe(['tag', '--list', `${prefix}*`, '--sort=-v:refname'], cwd);
  if (!raw) return null;
  const tags = raw.split('\n').filter(Boolean);
  return tags[0] ?? null;
}

export function commitAll(message: string, cwd?: string): void {
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
}
