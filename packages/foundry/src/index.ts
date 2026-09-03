/**
 * Joynt Foundry — public API exports.
 */
export type {
  FoundryConfig,
  AgentBackendDef,
  TaskState,
  RunnerState,
  AgentBackend,
  AgentLaunchParams,
  GitHubIssue,
} from './types.js';

export { loadConfig, loadConfigSafe, findConfigPath } from './config.js';
export { resolveBackend, resolveBackendForIssue } from './backends/index.js';
export type { StateStore } from './lib/state-store.js';
export { resolveStateStore, FileStateStore } from './lib/stores/index.js';
export type { Worker, WorkerHandle, WorkerSpawnOpts } from './lib/worker.js';
export { resolveWorker } from './lib/workers/index.js';
export { SubprocessWorker } from './lib/workers/subprocess.js';
export { recoverTask, issueNumberFromPayload, issueNumberFromBranch } from './lib/task-recovery.js';
export { buildAgentCompletedEvent, resolveBaseBranch } from './lib/completion.js';
