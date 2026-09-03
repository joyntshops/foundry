/**
 * FileStateStore tests — CRUD operations with real temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskState } from '../../types.js';
import { FileStateStore } from './file-store.js';

let tmpDir: string;
let store: FileStateStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-filestore-test-'));
  store = new FileStateStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(overrides?: Partial<TaskState>): TaskState {
  return {
    issue: 42,
    title: 'Fix bug',
    repo: 'owner/repo',
    branch: 'feature/42-fix-bug',
    worktree: '/tmp/wts/42-fix-bug',
    tmux_session: 'foundry-42',
    agent_backend: 'command',
    status: 'agent-running',
    claimed_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    runner_id: 'test-runner',
    ...overrides,
  };
}

describe('FileStateStore', () => {
  describe('getRunnerId', () => {
    it('generates and persists a runner ID', () => {
      const id = store.getRunnerId();

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');

      // Calling again returns the same ID
      const id2 = store.getRunnerId();
      expect(id2).toBe(id);
    });

    it('persists the runner ID to disk', () => {
      const id = store.getRunnerId();

      const filePath = path.join(tmpDir, 'runner-id');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8').trim()).toBe(id);
    });
  });

  describe('upsertTask + getAllTasks round-trip', () => {
    it('stores and retrieves a task', () => {
      const task = makeTask();

      store.upsertTask('owner/repo', task);
      const tasks = store.getAllTasks('owner/repo');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].issue).toBe(42);
      expect(tasks[0].title).toBe('Fix bug');
      expect(tasks[0].status).toBe('agent-running');
    });

    it('upserts (overwrites) an existing task', () => {
      store.upsertTask('owner/repo', makeTask());
      store.upsertTask('owner/repo', makeTask({ status: 'pr-open', pr_url: 'https://github.com/owner/repo/pull/1' }));

      const tasks = store.getAllTasks('owner/repo');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('pr-open');
      expect(tasks[0].pr_url).toBe('https://github.com/owner/repo/pull/1');
    });

    it('handles multiple tasks for the same repo', () => {
      store.upsertTask('owner/repo', makeTask({ issue: 1, title: 'Task 1' }));
      store.upsertTask('owner/repo', makeTask({ issue: 2, title: 'Task 2' }));
      store.upsertTask('owner/repo', makeTask({ issue: 3, title: 'Task 3' }));

      const tasks = store.getAllTasks('owner/repo');
      expect(tasks).toHaveLength(3);
    });
  });

  describe('updateTaskStatus', () => {
    it('changes the status of an existing task', () => {
      store.upsertTask('owner/repo', makeTask());

      store.updateTaskStatus('owner/repo', 42, 'verifying');

      const tasks = store.getAllTasks('owner/repo');
      expect(tasks[0].status).toBe('verifying');
      expect(tasks[0].updated_at).not.toBe('2024-01-01T00:00:00Z');
    });

    it('merges extra fields when provided', () => {
      store.upsertTask('owner/repo', makeTask());

      store.updateTaskStatus('owner/repo', 42, 'pr-open', {
        pr_url: 'https://github.com/owner/repo/pull/5',
        pr_number: 5,
      });

      const task = store.getTask('owner/repo', 42);
      expect(task?.status).toBe('pr-open');
      expect(task?.pr_url).toBe('https://github.com/owner/repo/pull/5');
      expect(task?.pr_number).toBe(5);
    });

    it('does nothing if the task does not exist', () => {
      // Should not throw
      store.updateTaskStatus('owner/repo', 999, 'failed');
      expect(store.getAllTasks('owner/repo')).toHaveLength(0);
    });
  });

  describe('removeTask', () => {
    it('removes an existing task', () => {
      store.upsertTask('owner/repo', makeTask({ issue: 1 }));
      store.upsertTask('owner/repo', makeTask({ issue: 2 }));

      store.removeTask('owner/repo', 1);

      const tasks = store.getAllTasks('owner/repo');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].issue).toBe(2);
    });

    it('does nothing if the task does not exist', () => {
      store.upsertTask('owner/repo', makeTask());

      store.removeTask('owner/repo', 999);

      expect(store.getAllTasks('owner/repo')).toHaveLength(1);
    });
  });

  describe('getActiveTaskCount', () => {
    it('counts non-terminal tasks', () => {
      store.upsertTask('owner/repo', makeTask({ issue: 1, status: 'agent-running' }));
      store.upsertTask('owner/repo', makeTask({ issue: 2, status: 'verifying' }));
      store.upsertTask('owner/repo', makeTask({ issue: 3, status: 'done' }));
      store.upsertTask('owner/repo', makeTask({ issue: 4, status: 'failed' }));
      store.upsertTask('owner/repo', makeTask({ issue: 5, status: 'stopped' }));

      expect(store.getActiveTaskCount('owner/repo')).toBe(2);
    });

    it('returns 0 for empty state', () => {
      expect(store.getActiveTaskCount('owner/repo')).toBe(0);
    });
  });

  describe('getTask', () => {
    it('returns the task for a given issue number', () => {
      store.upsertTask('owner/repo', makeTask({ issue: 42 }));

      const task = store.getTask('owner/repo', 42);
      expect(task).toBeDefined();
      expect(task?.issue).toBe(42);
    });

    it('returns undefined for non-existent issue', () => {
      expect(store.getTask('owner/repo', 999)).toBeUndefined();
    });
  });

  describe('getLogDir / getTaskStateDir', () => {
    it('returns a valid log directory path', () => {
      const logDir = store.getLogDir('owner/repo', 42);

      expect(logDir).toContain('logs');
      expect(logDir).toContain('owner__repo');
      expect(logDir).toContain('42');
      expect(fs.existsSync(logDir)).toBe(true);
    });

    it('returns a valid task state directory path', () => {
      const stateDir = store.getTaskStateDir('owner/repo', 42);

      expect(stateDir).toContain('tasks');
      expect(stateDir).toContain('owner__repo');
      expect(stateDir).toContain('42');
      expect(fs.existsSync(stateDir)).toBe(true);
    });
  });

  describe('loadState', () => {
    it('returns empty state for a new repo', () => {
      const st = store.loadState('owner/repo');

      expect(st.repo).toBe('owner/repo');
      expect(st.runner_id).toBeTruthy();
      expect(Object.keys(st.tasks)).toHaveLength(0);
    });

    it('returns saved state after upsertTask', () => {
      store.upsertTask('owner/repo', makeTask());

      const st = store.loadState('owner/repo');
      expect(Object.keys(st.tasks)).toHaveLength(1);
      expect(st.tasks[42].title).toBe('Fix bug');
    });

    it('handles corrupted state file gracefully', () => {
      // Write garbage to the state file
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'state-owner__repo.json'), 'not valid json');

      const st = store.loadState('owner/repo');
      expect(st.repo).toBe('owner/repo');
      expect(Object.keys(st.tasks)).toHaveLength(0);
    });
  });

  describe('atomic writes', () => {
    it('survives rapid sequential writes without corruption', () => {
      // Write many tasks rapidly
      for (let i = 1; i <= 20; i++) {
        store.upsertTask('owner/repo', makeTask({ issue: i, title: `Task ${i}` }));
      }

      const tasks = store.getAllTasks('owner/repo');
      expect(tasks).toHaveLength(20);

      // Verify all tasks are intact
      for (let i = 1; i <= 20; i++) {
        const task = store.getTask('owner/repo', i);
        expect(task?.title).toBe(`Task ${i}`);
      }
    });
  });

  describe('repo isolation', () => {
    it('keeps tasks separate across different repos', () => {
      store.upsertTask('owner/repo-a', makeTask({ issue: 1 }));
      store.upsertTask('owner/repo-b', makeTask({ issue: 2 }));

      expect(store.getAllTasks('owner/repo-a')).toHaveLength(1);
      expect(store.getAllTasks('owner/repo-b')).toHaveLength(1);
      expect(store.getAllTasks('owner/repo-a')[0].issue).toBe(1);
      expect(store.getAllTasks('owner/repo-b')[0].issue).toBe(2);
    });
  });
});
