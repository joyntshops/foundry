/**
 * Agent completion — turn an exited agent into an AgentCompletedEvent.
 *
 * Shared by the Poller (which discovers exits by polling worker handles) and
 * `foundry action` (which waits on the subprocess directly). Both must
 * classify the outcome identically, so the logic lives here once.
 */
import * as path from 'node:path';
import * as state from './state.js';
import * as git from './git.js';
import * as agentOutput from './agent-output.js';
import type { FoundryConfig, TaskState } from '../types.js';
import type { AgentCompletedEvent } from './events.js';

/** The branch agent work is measured against: integration if it exists, else main. */
export function resolveBaseBranch(repoDir: string): string {
  return git.remoteBranchExists('integration', repoDir) ? 'origin/integration' : 'origin/main';
}

export function agentLogPath(config: FoundryConfig, issue: number): string {
  return path.join(state.getLogDir(config.repo, issue), 'agent.log');
}

export function buildAgentCompletedEvent(
  config: FoundryConfig,
  repoDir: string,
  task: TaskState,
): AgentCompletedEvent {
  const logPath = agentLogPath(config, task.issue);
  const baseBranch = resolveBaseBranch(repoDir);
  const outcome = agentOutput.determineOutcome(logPath, task.worktree, baseBranch, {
    permissionMode: task.permission_mode,
  });
  return { type: 'agent_completed', task, outcome };
}
