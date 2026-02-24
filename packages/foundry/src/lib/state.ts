/**
 * Local state management — ~/.joynt-foundry/
 *
 * All operations are idempotent and crash-safe (atomic writes).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { RunnerState, TaskState } from '../types.js';

const STATE_DIR = path.join(os.homedir(), '.joynt-foundry');
const RUNNER_ID_FILE = path.join(STATE_DIR, 'runner-id');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function stateFile(repo: string): string {
  const safe = repo.replace(/\//g, '__');
  return path.join(STATE_DIR, `state-${safe}.json`);
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function getStateDir(): string {
  ensureDir(STATE_DIR);
  return STATE_DIR;
}

export function getLogDir(repo: string, issue: number): string {
  const dir = path.join(STATE_DIR, 'logs', repo.replace(/\//g, '__'), String(issue));
  ensureDir(dir);
  return dir;
}

export function getTaskStateDir(repo: string, issue: number): string {
  const dir = path.join(STATE_DIR, 'tasks', repo.replace(/\//g, '__'), String(issue));
  ensureDir(dir);
  return dir;
}

export function getRunnerId(): string {
  ensureDir(STATE_DIR);
  if (fs.existsSync(RUNNER_ID_FILE)) {
    return fs.readFileSync(RUNNER_ID_FILE, 'utf-8').trim();
  }
  const id = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
  atomicWrite(RUNNER_ID_FILE, id);
  return id;
}

export function loadRunnerState(repo: string): RunnerState {
  const file = stateFile(repo);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      // corrupted — start fresh
    }
  }
  return { runner_id: getRunnerId(), repo, tasks: {} };
}

export function saveRunnerState(state: RunnerState): void {
  ensureDir(STATE_DIR);
  atomicWrite(stateFile(state.repo), JSON.stringify(state, null, 2));
}

export function upsertTask(repo: string, task: TaskState): void {
  const state = loadRunnerState(repo);
  state.tasks[task.issue] = task;
  state.runner_id = getRunnerId();
  saveRunnerState(state);
}

export function updateTaskStatus(repo: string, issue: number, status: TaskState['status'], extra?: Partial<TaskState>): void {
  const state = loadRunnerState(repo);
  const t = state.tasks[issue];
  if (!t) return;
  t.status = status;
  t.updated_at = new Date().toISOString();
  if (extra) Object.assign(t, extra);
  saveRunnerState(state);
}

export function removeTask(repo: string, issue: number): void {
  const state = loadRunnerState(repo);
  delete state.tasks[issue];
  saveRunnerState(state);
}

export function getActiveTaskCount(repo: string): number {
  const state = loadRunnerState(repo);
  return Object.values(state.tasks).filter(
    t => !['done', 'failed', 'stopped'].includes(t.status)
  ).length;
}

export function getAllTasks(repo: string): TaskState[] {
  const state = loadRunnerState(repo);
  return Object.values(state.tasks);
}

/**
 * List all issue numbers that have task directories under ~/.joynt-foundry/tasks/{repo-slug}/.
 * Falls back to state JSON task keys if the directory doesn't exist.
 */
export function listTaskIssueNumbers(repo: string): number[] {
  const safe = repo.replace(/\//g, '__');
  const tasksDir = path.join(STATE_DIR, 'tasks', safe);

  const issueSet = new Set<number>();

  // Scan task subdirectories (each named by issue number)
  if (fs.existsSync(tasksDir)) {
    try {
      const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const num = parseInt(entry.name, 10);
          if (!isNaN(num)) issueSet.add(num);
        }
      }
    } catch {}
  }

  // Also include issues from state JSON
  const st = loadRunnerState(repo);
  for (const key of Object.keys(st.tasks)) {
    const num = parseInt(key, 10);
    if (!isNaN(num)) issueSet.add(num);
  }

  return Array.from(issueSet).sort((a, b) => a - b);
}
