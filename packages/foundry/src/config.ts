/**
 * Configuration loader for .joynt-foundry.yml
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FoundryConfig } from './types.js';

const CONFIG_FILENAME = '.joynt-foundry.yml';

const DEFAULTS: FoundryConfig = {
  repo: '',
  labels: {
    ready: 'state:ready',
    in_progress: 'state:in-progress',
    done: 'state:done',
    ready_for_review: 'state:ready-for-human-review',
    spec_changed: 'spec:changed',
    waiting_for_input: 'state:waiting-for-input',
    failed: 'state:failed',
  },
  branch_template: 'feature/{issue}-{slug}',
  worktree_base: './wts',
  tmux_template: 'foundry-{issue}',
  max_sessions: 4,
  max_verify_parallel: 1,
  max_input_rounds: 3,
  verify: [],
  integration_rebuild: '',
  comment_triggers: {
    replan: '@foundry replan',
    restart: '@foundry restart',
  },
  version_sources: [],
  tag_prefix: 'v',
  default_agent_backend: 'command',
  agent_backends: {
    command: {
      type: 'command',
      command: 'echo "No agent command configured. Set agent_backends in .joynt-foundry.yml"',
    },
  },
  poll_interval_seconds: 30,
};

/**
 * Deep merge b into a (a is base, b overrides).
 */
function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (
      b[key] !== null &&
      typeof b[key] === 'object' &&
      !Array.isArray(b[key]) &&
      typeof a[key] === 'object' &&
      !Array.isArray(a[key])
    ) {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

export function findConfigPath(startDir?: string): string | null {
  let dir = startDir ?? process.cwd();
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(startDir?: string): FoundryConfig {
  const configPath = findConfigPath(startDir);
  if (!configPath) {
    throw new Error(
      `No ${CONFIG_FILENAME} found. Run \`foundry init\` to create one.`
    );
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};
  return deepMerge(DEFAULTS as any, parsed) as FoundryConfig;
}

export function loadConfigSafe(startDir?: string): FoundryConfig | null {
  try {
    return loadConfig(startDir);
  } catch {
    return null;
  }
}

export function getConfigDir(startDir?: string): string {
  const configPath = findConfigPath(startDir);
  if (!configPath) return process.cwd();
  return path.dirname(configPath);
}

export { CONFIG_FILENAME, DEFAULTS };
