/**
 * Worker registry — resolves worker type strings to Worker implementations.
 */
import type { Worker } from '../worker.js';
import { LocalTmuxWorker } from './local-tmux.js';

const workers: Record<string, () => Worker> = {
  'local-tmux': () => new LocalTmuxWorker(),
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
