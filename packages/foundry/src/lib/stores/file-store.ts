/**
 * FileStateStore — file-based state persistence under ~/.joynt-foundry/.
 *
 * This is a direct lift of the original lib/state.ts logic into a class
 * that implements the StateStore interface.  All paths and atomic-write
 * semantics are preserved exactly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { RunnerState, TaskState, TaskStatus } from '../../types.js';
import type { StateStore } from '../state-store.js';

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.joynt-foundry');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export class FileStateStore implements StateStore {
  private readonly stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? DEFAULT_STATE_DIR;
  }

  private stateFile(repo: string): string {
    const safe = repo.replace(/\//g, '__');
    return path.join(this.stateDir, `state-${safe}.json`);
  }

  private runnerIdFile(): string {
    return path.join(this.stateDir, 'runner-id');
  }

  getRunnerId(): string {
    ensureDir(this.stateDir);
    const file = this.runnerIdFile();
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf-8').trim();
    }
    const id = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
    atomicWrite(file, id);
    return id;
  }

  getStateDir(): string {
    ensureDir(this.stateDir);
    return this.stateDir;
  }

  loadState(repo: string): RunnerState {
    const file = this.stateFile(repo);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        // corrupted — start fresh
      }
    }
    return { runner_id: this.getRunnerId(), repo, tasks: {} };
  }

  saveState(state: RunnerState): void {
    ensureDir(this.stateDir);
    atomicWrite(this.stateFile(state.repo), JSON.stringify(state, null, 2));
  }

  upsertTask(repo: string, task: TaskState): void {
    const state = this.loadState(repo);
    state.tasks[task.issue] = task;
    state.runner_id = this.getRunnerId();
    this.saveState(state);
  }

  updateTaskStatus(repo: string, issue: number, status: TaskStatus, extra?: Partial<TaskState>): void {
    const state = this.loadState(repo);
    const t = state.tasks[issue];
    if (!t) return;
    t.status = status;
    t.updated_at = new Date().toISOString();
    if (extra) Object.assign(t, extra);
    this.saveState(state);
  }

  removeTask(repo: string, issue: number): void {
    const state = this.loadState(repo);
    delete state.tasks[issue];
    this.saveState(state);
  }

  getActiveTaskCount(repo: string): number {
    const state = this.loadState(repo);
    return Object.values(state.tasks).filter(
      t => !['done', 'failed', 'stopped'].includes(t.status)
    ).length;
  }

  getAllTasks(repo: string): TaskState[] {
    const state = this.loadState(repo);
    return Object.values(state.tasks);
  }

  getTask(repo: string, issue: number): TaskState | undefined {
    const state = this.loadState(repo);
    return state.tasks[issue];
  }

  listTaskIssueNumbers(repo: string): number[] {
    const safe = repo.replace(/\//g, '__');
    const tasksDir = path.join(this.stateDir, 'tasks', safe);

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
    const st = this.loadState(repo);
    for (const key of Object.keys(st.tasks)) {
      const num = parseInt(key, 10);
      if (!isNaN(num)) issueSet.add(num);
    }

    return Array.from(issueSet).sort((a, b) => a - b);
  }

  getLogDir(repo: string, issue: number): string {
    const dir = path.join(this.stateDir, 'logs', repo.replace(/\//g, '__'), String(issue));
    ensureDir(dir);
    return dir;
  }

  getTaskStateDir(repo: string, issue: number): string {
    const dir = path.join(this.stateDir, 'tasks', repo.replace(/\//g, '__'), String(issue));
    ensureDir(dir);
    return dir;
  }
}
