import { describe, it, expect } from 'vitest';
import { runCommand, describeFailure } from './run-command.js';

describe('runCommand', () => {
  it('captures stdout and stderr and the exit status', async () => {
    const r = await runCommand("sh -c 'echo out; echo err >&2; exit 3'", { timeoutMs: 5000 });
    expect(r.success).toBe(false);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
    expect(r.timedOut).toBe(false);
  });

  it('runs through a shell with the given env and cwd', async () => {
    const r = await runCommand('echo "$FOO" && pwd', { timeoutMs: 5000, cwd: '/', env: { ...process.env, FOO: 'bar' } });
    expect(r.success).toBe(true);
    expect(r.stdout).toBe('bar\n/\n');
  });

  it('kills the command at the timeout and says so', async () => {
    const start = Date.now();
    const r = await runCommand('sleep 30', { timeoutMs: 150 });
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(describeFailure(r, 150)).toBe('timed out after 0s');
  });

  it('kills what the shell started, not only the shell', async () => {
    // `sleep` is a child of the shell here (not exec'd: two commands), and
    // holds the stdout pipe open; the whole group must go.
    const start = Date.now();
    const r = await runCommand('echo started; sleep 30', { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe('started\n');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('does not block the event loop while the command runs', async () => {
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 10);
    await runCommand('sleep 0.3', { timeoutMs: 5000 });
    clearInterval(interval);
    expect(ticks).toBeGreaterThan(5);
  });

  it('reports a command that cannot start', async () => {
    const r = await runCommand('/nonexistent/binary-xyz', { timeoutMs: 5000 });
    expect(r.success).toBe(false);
    expect(r.status).not.toBe(0);
  });
});
