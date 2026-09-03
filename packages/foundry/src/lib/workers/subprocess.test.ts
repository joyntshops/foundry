/**
 * SubprocessWorker tests — real child processes, kept fast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import { SubprocessWorker } from './subprocess.js';

describe('SubprocessWorker', () => {
  let worker: SubprocessWorker;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    worker = new SubprocessWorker();
    // Keep test output clean; the worker streams child output to stdout.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('has the name "subprocess"', () => {
    expect(worker.name).toBe('subprocess');
  });

  it('runs the command to completion and reports the exit code', async () => {
    const handle = await worker.spawn({ id: 'ok', cwd: os.tmpdir(), command: 'echo hello; exit 0' });
    expect(await handle.isRunning()).toBe(true);
    const code = await handle.wait!();
    expect(code).toBe(0);
    expect(await handle.isRunning()).toBe(false);
    expect(await handle.getLogs()).toContain('hello');
  });

  it('surfaces a non-zero exit code', async () => {
    const handle = await worker.spawn({ id: 'fail', cwd: os.tmpdir(), command: 'exit 3' });
    expect(await handle.wait!()).toBe(3);
  });

  it('runs in the requested cwd with the requested env', async () => {
    const handle = await worker.spawn({
      id: 'env',
      cwd: os.tmpdir(),
      command: 'pwd; echo "$FOUNDRY_TEST_VAR"',
      env: { FOUNDRY_TEST_VAR: 'from-worker' },
    });
    await handle.wait!();
    const logs = await handle.getLogs();
    expect(logs).toContain('from-worker');
    // macOS resolves /var → /private/var, so compare realpath-insensitively.
    expect(logs.replace('/private', '')).toContain(os.tmpdir().replace('/private', ''));
  });

  it('handleFor returns the live handle for a spawned id', async () => {
    await worker.spawn({ id: 'sleepy', cwd: os.tmpdir(), command: 'sleep 5' });
    const again = worker.handleFor('sleepy');
    expect(await again.isRunning()).toBe(true);
    await again.kill();
    expect(await again.isRunning()).toBe(false);
  });

  it('handleFor on an unknown id reports not running', async () => {
    const handle = worker.handleFor('never-spawned');
    expect(await handle.isRunning()).toBe(false);
    expect(await handle.getLogs()).toBe('');
    expect(await handle.wait!()).toBeNull();
  });

  it('refuses to spawn a duplicate id while the first is running', async () => {
    const first = await worker.spawn({ id: 'dup', cwd: os.tmpdir(), command: 'sleep 5' });
    await expect(worker.spawn({ id: 'dup', cwd: os.tmpdir(), command: 'echo again' }))
      .rejects.toThrow(/already running/);
    await first.kill();
  });

  it('allows re-spawning an id after it has exited', async () => {
    const first = await worker.spawn({ id: 'again', cwd: os.tmpdir(), command: 'exit 0' });
    await first.wait!();
    const second = await worker.spawn({ id: 'again', cwd: os.tmpdir(), command: 'echo second' });
    await second.wait!();
    expect(await second.getLogs()).toContain('second');
  });
});
