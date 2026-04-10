/**
 * LocalTmuxWorker — Worker implementation that delegates to lib/tmux.ts.
 *
 * Spawns agent processes inside local tmux sessions.
 */
import * as tmux from '../tmux.js';
import type { Worker, WorkerHandle, WorkerSpawnOpts } from '../worker.js';

class LocalTmuxHandle implements WorkerHandle {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async isRunning(): Promise<boolean> {
    return tmux.sessionExists(this.id);
  }

  async kill(): Promise<void> {
    tmux.killSession(this.id);
  }

  async getLogs(lines: number = 50): Promise<string> {
    return tmux.capturePane(this.id, lines) ?? '';
  }

  async attach(): Promise<void> {
    tmux.attachSession(this.id);
  }
}

export class LocalTmuxWorker implements Worker {
  readonly name = 'local-tmux';

  handleFor(id: string): WorkerHandle {
    return new LocalTmuxHandle(id);
  }

  async spawn(opts: WorkerSpawnOpts): Promise<WorkerHandle> {
    // Create tmux session in the given working directory
    tmux.createSession(opts.id, opts.cwd);

    // Set env vars in the tmux session
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        tmux.sendKeys(opts.id, `export ${k}="${v}"`);
      }
    }

    // Launch command — `; exit` ensures the shell (and tmux session) closes
    // when the command finishes, so completion is detected via isRunning().
    tmux.sendKeys(opts.id, `${opts.command}; exit`);

    return new LocalTmuxHandle(opts.id);
  }
}
