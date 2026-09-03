/**
 * Worker registry — resolves a worker type to a Worker implementation.
 *
 * Only `subprocess` exists: the agent runs as a child of the current process,
 * which under the GitHub Action means the job is the isolation boundary. The
 * Worker interface is kept so another execution model can be added without
 * touching the EventHandler.
 */
import type { Worker } from '../worker.js';
import { SubprocessWorker } from './subprocess.js';

// The subprocess worker tracks children in memory, so it must be a singleton
// within the process or handleFor() would lose them.
let subprocessSingleton: SubprocessWorker | undefined;

const workers: Record<string, () => Worker> = {
  subprocess: () => (subprocessSingleton ??= new SubprocessWorker()),
};

export function resolveWorker(type: string = 'subprocess'): Worker {
  const factory = workers[type];
  if (!factory) {
    throw new Error(
      `Unknown worker type "${type}". Available: ${Object.keys(workers).join(', ')}`
    );
  }
  return factory();
}
