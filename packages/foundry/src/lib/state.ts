/**
 * Local state management — ~/.joynt-foundry/
 *
 * All operations are idempotent and crash-safe (atomic writes).
 *
 * This module now delegates to a FileStateStore singleton, preserving the
 * original function-based API for backwards compatibility.
 */
import type { RunnerState, TaskState } from '../types.js';
import { FileStateStore } from './stores/file-store.js';

const store = new FileStateStore();

export function getStateDir(): string {
  return store.getStateDir();
}

export function getLogDir(repo: string, issue: number): string {
  return store.getLogDir(repo, issue);
}

export function getTaskStateDir(repo: string, issue: number): string {
  return store.getTaskStateDir(repo, issue);
}

export function getRunnerId(): string {
  return store.getRunnerId();
}

export function loadRunnerState(repo: string): RunnerState {
  return store.loadState(repo);
}

export function saveRunnerState(state: RunnerState): void {
  store.saveState(state);
}

export function upsertTask(repo: string, task: TaskState): void {
  store.upsertTask(repo, task);
}

export function updateTaskStatus(repo: string, issue: number, status: TaskState['status'], extra?: Partial<TaskState>): void {
  store.updateTaskStatus(repo, issue, status, extra);
}

export function removeTask(repo: string, issue: number): void {
  store.removeTask(repo, issue);
}

export function getActiveTaskCount(repo: string): number {
  return store.getActiveTaskCount(repo);
}

export function getAllTasks(repo: string): TaskState[] {
  return store.getAllTasks(repo);
}

export function listTaskIssueNumbers(repo: string): number[] {
  return store.listTaskIssueNumbers(repo);
}

export function getTask(repo: string, issue: number): TaskState | undefined {
  return store.getTask(repo, issue);
}
