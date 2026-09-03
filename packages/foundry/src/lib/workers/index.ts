/**
 * Worker registry — resolves worker type strings to Worker implementations.
 */
import type { Worker } from '../worker.js';
import { LocalTmuxWorker } from './local-tmux.js';
import { SubprocessWorker } from './subprocess.js';

// The subprocess worker tracks children in memory, so it must be a
// singleton within the process or handleFor() would lose them.
let subprocessSingleton: SubprocessWorker | undefined;

const workers: Record<string, () => Worker> = {
  'local-tmux': () => new LocalTmuxWorker(),
  'subprocess': () => (subprocessSingleton ??= new SubprocessWorker()),
};

export function resolveWorker(type: string = 'local-tmux'): Worker {
  const factory = workers[type];
  if (!factory) {
    throw new Error(
      `Unknown worker type "${type}". Available: ${Object.keys(workers).join(', ')}`
    );
  }
  return factory();
}
