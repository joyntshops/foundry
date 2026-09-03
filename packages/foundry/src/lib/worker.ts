/**
 * Worker interface — how an agent process is executed.
 *
 * Implementation: SubprocessWorker (agent as a child of the job).
 * The interface is kept so another execution model can be added later.
 */

export interface WorkerHandle {
  /** Unique worker identifier (e.g. `foundry-42`) */
  id: string;

  /** Check if the worker process is still running */
  isRunning(): Promise<boolean>;

  /** Kill the worker process */
  kill(): Promise<void>;

  /** Capture recent output from the worker */
  getLogs(lines?: number): Promise<string>;

  /** Interactively attach to the worker (optional — not all backends support it) */
  attach?(): Promise<void>;

  /**
   * Wait for the worker to exit and resolve with its exit code (optional —
   * only in-process workers can offer this). Null if unknown or killed.
   */
  wait?(): Promise<number | null>;
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
  /** Worker backend name (e.g. 'subprocess') */
  name: string;

  /** Spawn a new worker process and return a handle to it */
  spawn(opts: WorkerSpawnOpts): Promise<WorkerHandle>;

  /** Get a handle for an existing worker by id (e.g. reconnect after restart) */
  handleFor(id: string): WorkerHandle;
}
