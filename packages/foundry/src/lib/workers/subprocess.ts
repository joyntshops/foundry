/**
 * SubprocessWorker — runs the agent as a child process of the current
 * Node process, streaming its output to stdout.
 *
 * This is the worker for `foundry action`, where the GitHub Actions job is
 * the isolation boundary and nothing needs to outlive the process. There is
 * no tmux, no detach, no reattach: the job waits on the child directly.
 *
 * Handles are tracked in-memory for the lifetime of the process. `handleFor`
 * on an id this process never spawned returns a handle that reports
 * not-running, which is the correct answer inside a fresh job.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Worker, WorkerHandle, WorkerSpawnOpts } from '../worker.js';

const MAX_BUFFERED_LINES = 2000;
const KILL_GRACE_MS = 5_000;

interface Tracked {
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
  lines: string[];
  done: Promise<number | null>;
}

class SubprocessHandle implements WorkerHandle {
  constructor(readonly id: string, private readonly tracked: Tracked | undefined) {}

  async isRunning(): Promise<boolean> {
    return this.tracked ? !this.tracked.exited : false;
  }

  async kill(): Promise<void> {
    const t = this.tracked;
    if (!t || t.exited) return;
    t.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!t.exited) t.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    await t.done;
    clearTimeout(timer);
  }

  async getLogs(lines: number = 50): Promise<string> {
    if (!this.tracked) return '';
    return this.tracked.lines.slice(-lines).join('\n');
  }

  /** Resolve with the exit code once the child exits. Null if killed by signal. */
  async wait(): Promise<number | null> {
    if (!this.tracked) return null;
    return this.tracked.done;
  }
}

export class SubprocessWorker implements Worker {
  readonly name = 'subprocess';
  private readonly tracked = new Map<string, Tracked>();

  handleFor(id: string): WorkerHandle {
    return new SubprocessHandle(id, this.tracked.get(id));
  }

  async spawn(opts: WorkerSpawnOpts): Promise<WorkerHandle> {
    const existing = this.tracked.get(opts.id);
    if (existing && !existing.exited) {
      throw new Error(`Worker "${opts.id}" is already running.`);
    }

    const child = spawn('bash', ['-lc', opts.command], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    const record = (chunk: Buffer, sink: NodeJS.WriteStream) => {
      sink.write(chunk);
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line.length === 0) continue;
        lines.push(line);
        if (lines.length > MAX_BUFFERED_LINES) lines.shift();
      }
    };
    child.stdout?.on('data', (c: Buffer) => record(c, process.stdout));
    child.stderr?.on('data', (c: Buffer) => record(c, process.stderr));

    const entry: Tracked = {
      child,
      exited: false,
      exitCode: null,
      lines,
      done: new Promise<number | null>(resolve => {
        child.on('error', () => {
          entry.exited = true;
          entry.exitCode = null;
          resolve(null);
        });
        child.on('exit', (code) => {
          entry.exited = true;
          entry.exitCode = code;
          resolve(code);
        });
      }),
    };
    this.tracked.set(opts.id, entry);

    return new SubprocessHandle(opts.id, entry);
  }
}
