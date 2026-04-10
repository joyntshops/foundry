/**
 * StateStore — abstract interface for task/runner state persistence.
 *
 * The default implementation is FileStateStore (file-based, ~/.joynt-foundry/).
 * Future implementations may use SQLite, PostgreSQL, etc.
 */
import type { RunnerState, TaskState, TaskStatus } from '../types.js';

export interface StateStore {
  getRunnerId(): string;
  getStateDir(): string;
  loadState(repo: string): RunnerState;
  saveState(state: RunnerState): void;
  upsertTask(repo: string, task: TaskState): void;
  updateTaskStatus(repo: string, issue: number, status: TaskStatus, extra?: Partial<TaskState>): void;
  removeTask(repo: string, issue: number): void;
  getActiveTaskCount(repo: string): number;
  getAllTasks(repo: string): TaskState[];
  getTask(repo: string, issue: number): TaskState | undefined;
  listTaskIssueNumbers(repo: string): number[];
  getLogDir(repo: string, issue: number): string;
  getTaskStateDir(repo: string, issue: number): string;
}
