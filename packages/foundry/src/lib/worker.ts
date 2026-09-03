/**
 * Worker interface — abstracts agent execution away from tmux.
 *
 * Implementations: LocalTmuxWorker (local tmux sessions),
 * future: ContainerWorker, CloudWorker, etc.
 */

export interface WorkerHandle {
  /** Unique worker identifier (e.g. tmux session name) */
  id: string;

  /** Check if the worker process is still running */
  isRunning(): Promise<boolean>;

  /** Kill the worker process */
  kill(): Promise<void>;

  /** Capture recent output from the worker */
  getLogs(lines?: number): Promise<string>;

  /** Interactively attach to the worker (optional — not all backends support it) */
  attach?(): Promise<void>;
}

export interface WorkerSpawnOpts {
  /** Session/container name */
  id: string;

  /** Working directory */
  cwd: string;

  /** Command to execute */
  command: string;

  /** Environment variables to set before running the command */
  env?: Record<string, string>;
}

export interface Worker {
  /** Worker backend name (e.g. 'local-tmux') */
  name: string;

  /** Spawn a new worker process and return a handle to it */
  spawn(opts: WorkerSpawnOpts): Promise<WorkerHandle>;

  /** Get a handle for an existing worker by id (e.g. reconnect after restart) */
  handleFor(id: string): WorkerHandle;
}
