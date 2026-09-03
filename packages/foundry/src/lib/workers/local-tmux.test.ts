/**
 * LocalTmuxWorker tests — mock the tmux module to verify correct delegation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tmux module before importing the worker
vi.mock('../tmux.js', () => ({
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sessionExists: vi.fn(),
  killSession: vi.fn(),
  capturePane: vi.fn(),
  attachSession: vi.fn(),
}));

import * as tmux from '../tmux.js';
import { LocalTmuxWorker } from './local-tmux.js';

const mockCreateSession = vi.mocked(tmux.createSession);
const mockSendKeys = vi.mocked(tmux.sendKeys);
const mockSessionExists = vi.mocked(tmux.sessionExists);
const mockKillSession = vi.mocked(tmux.killSession);
const mockCapturePane = vi.mocked(tmux.capturePane);

describe('LocalTmuxWorker', () => {
  let worker: LocalTmuxWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new LocalTmuxWorker();
  });

  it('has the name "local-tmux"', () => {
    expect(worker.name).toBe('local-tmux');
  });

  describe('spawn', () => {
    it('creates a tmux session and sends the command', async () => {
      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/worktree',
        command: 'claude --task "do stuff"',
      });

      expect(mockCreateSession).toHaveBeenCalledWith('foundry-42', '/tmp/worktree');
      expect(mockSendKeys).toHaveBeenCalledWith('foundry-42', 'claude --task "do stuff"; exit');
      expect(handle.id).toBe('foundry-42');
    });

    it('sets env vars before running the command', async () => {
      await worker.spawn({
        id: 'foundry-99',
        cwd: '/tmp/wt',
        command: 'echo hello',
        env: { FOO: 'bar', BAZ: 'qux' },
      });

      // First call: createSession
      expect(mockCreateSession).toHaveBeenCalledWith('foundry-99', '/tmp/wt');

      // Env var exports should come before the command
      const sendKeysCalls = mockSendKeys.mock.calls;
      expect(sendKeysCalls).toHaveLength(3); // 2 env vars + 1 command
      expect(sendKeysCalls[0]).toEqual(['foundry-99', 'export FOO="bar"']);
      expect(sendKeysCalls[1]).toEqual(['foundry-99', 'export BAZ="qux"']);
      expect(sendKeysCalls[2]).toEqual(['foundry-99', 'echo hello; exit']);
    });

    it('does not send env exports when env is undefined', async () => {
      await worker.spawn({
        id: 'foundry-1',
        cwd: '/tmp/wt',
        command: 'run-agent',
      });

      expect(mockSendKeys).toHaveBeenCalledTimes(1);
      expect(mockSendKeys).toHaveBeenCalledWith('foundry-1', 'run-agent; exit');
    });
  });

  describe('WorkerHandle.isRunning', () => {
    it('returns true when the tmux session exists', async () => {
      mockSessionExists.mockReturnValue(true);

      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/wt',
        command: 'run',
      });

      expect(await handle.isRunning()).toBe(true);
      expect(mockSessionExists).toHaveBeenCalledWith('foundry-42');
    });

    it('returns false when the tmux session does not exist', async () => {
      mockSessionExists.mockReturnValue(false);

      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/wt',
        command: 'run',
      });

      expect(await handle.isRunning()).toBe(false);
    });
  });

  describe('WorkerHandle.kill', () => {
    it('kills the tmux session', async () => {
      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/wt',
        command: 'run',
      });

      await handle.kill();
      expect(mockKillSession).toHaveBeenCalledWith('foundry-42');
    });
  });

  describe('WorkerHandle.getLogs', () => {
    it('captures pane content with default line count', async () => {
      mockCapturePane.mockReturnValue('line 1\nline 2\nline 3');

      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/wt',
        command: 'run',
      });

      const logs = await handle.getLogs();
      expect(logs).toBe('line 1\nline 2\nline 3');
      expect(mockCapturePane).toHaveBeenCalledWith('foundry-42', 50);
    });

    it('captures pane content with custom line count', async () => {
      mockCapturePane.mockReturnValue('some output');

      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/wt',
        command: 'run',
      });

      await handle.getLogs(100);
      expect(mockCapturePane).toHaveBeenCalledWith('foundry-42', 100);
    });

    it('returns empty string when capturePane returns null', async () => {
      mockCapturePane.mockReturnValue(null);

      const handle = await worker.spawn({
        id: 'foundry-42',
        cwd: '/tmp/wt',
        command: 'run',
      });

      const logs = await handle.getLogs();
      expect(logs).toBe('');
    });
  });

  describe('handleFor', () => {
    it('returns a handle for an existing session ID', () => {
      const handle = worker.handleFor('foundry-42');

      expect(handle.id).toBe('foundry-42');
      // Verify it can still call tmux methods
      mockSessionExists.mockReturnValue(true);
      handle.isRunning().then(running => expect(running).toBe(true));
    });

    it('handle can kill the session', async () => {
      const handle = worker.handleFor('foundry-99');
      await handle.kill();
      expect(mockKillSession).toHaveBeenCalledWith('foundry-99');
    });
  });
});
