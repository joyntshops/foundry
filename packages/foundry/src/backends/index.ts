/**
 * Agent backend registry
 */
import type { AgentBackend, FoundryConfig } from '../types.js';
import { createCommandBackend, CLAUDE_CODE_PRESET } from './command.js';

export function resolveBackend(config: FoundryConfig, backendName?: string): AgentBackend {
  const name = backendName ?? config.default_agent_backend;
  const def = config.agent_backends[name];

  if (!def) {
    throw new Error(
      `Agent backend "${name}" not found in config. Available: ${Object.keys(config.agent_backends).join(', ')}`
    );
  }

  if (def.type === 'command') {
    return createCommandBackend(name, def);
  }

  throw new Error(`Unknown backend type: ${def.type}`);
}

export function resolveBackendForIssue(
  config: FoundryConfig,
  issueLabels: string[],
): AgentBackend {
  if (config.agent_label_map) {
    for (const label of issueLabels) {
      const mapped = config.agent_label_map[label];
      if (mapped) {
        return resolveBackend(config, mapped);
      }
    }
  }
  return resolveBackend(config);
}

export { CLAUDE_CODE_PRESET };
