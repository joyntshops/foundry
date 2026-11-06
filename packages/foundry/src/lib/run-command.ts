/**
 * Run a shell command without blocking the event loop.
 *
 * Foundry used to run verify steps and preview commands with execSync. A
 * blocking child process stalls everything else in the job for its whole
 * duration, and the GitHub client is the casualty: while the loop is
 * blocked, the keep-alive socket under Octokit's fetch can be closed by the
 * server without Node noticing, and the first request after the block dies
 * with `write EPIPE`. Spawning asynchronously lets Node see the close and
 * open a fresh connection. It also lets the timeout be as long as the task
 * needs; a sync call's timeout freezes the whole job for that long.
 *
 * The command runs through the platform shell like execSync did, so
 * `FOO=bar cmd && other` keeps working. It gets its own process group, so
 * the timeout can kill the whole tree (the shell and whatever it started,
 * such as a deploy script's polling loop) with SIGTERM and, if anything is
 * still alive a few seconds later, SIGKILL.
 */
import { spawn } from 'node:child_process';

export interface RunCommandOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the command after this long. */
  timeoutMs: number;
}

export interface RunCommandResult {
  /** Exit status 0 and no timeout. */
  success: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  duration_ms: number;
}

/** Keep at most this much of each stream; callers take a tail of it anyway. */
const MAX_CAPTURE = 1_000_000;
const KILL_GRACE_MS = 5_000;

function append(buf: string, chunk: Buffer): string {
  const next = buf + chunk.toString('utf-8');
  return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
}

export function runCommand(command: string, opts: RunCommandOpts): Promise<RunCommandResult> {
  const start = Date.now();
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    child.stdout?.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr?.on('data', (c: Buffer) => { stderr = append(stderr, c); });

    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        success: status === 0 && !timedOut,
        stdout,
        stderr,
        status,
        signal,
        timedOut,
        duration_ms: Date.now() - start,
      });
    };

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }, opts.timeoutMs);

    child.on('error', err => {
      stderr = append(stderr, Buffer.from(`${err.message}\n`));
      finish(null, null);
    });
    // 'close' waits for the pipes, which a surviving grandchild can hold
    // open; after a timeout the shell's exit is the end of it.
    child.on('exit', (status, signal) => { if (timedOut) finish(status, signal); });
    child.on('close', (status, signal) => finish(status, signal));
  });
}

/** The command's failure, one line, for logs: "exit 2", "timed out after 120s", "killed by SIGTERM". */
export function describeFailure(r: RunCommandResult, timeoutMs: number): string {
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status ?? 'unknown'}`;
}
