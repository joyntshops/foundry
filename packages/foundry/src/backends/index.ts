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
    if (def.preset && def.preset !== 'claude-code') {
      throw new Error(`Agent backend "${name}": unknown preset "${def.preset}". Available: claude-code`);
    }
    const command = def.command ?? (def.preset === 'claude-code' ? CLAUDE_CODE_PRESET.command : undefined);
    if (!command) {
      throw new Error(`Agent backend "${name}" needs a \`command\` or \`preset: claude-code\`.`);
    }
    return createCommandBackend(name, { ...def, command });
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
