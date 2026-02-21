/**
 * foundry init — scaffold .joynt-foundry.yml and create required labels.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { CONFIG_FILENAME } from '../config.js';
import * as github from '../lib/github.js';
import * as log from '../lib/log.js';
import * as git from '../lib/git.js';

const LABEL_DEFS: Array<{ name: string; color: string; description: string }> = [
  { name: 'state:ready', color: '0e8a16', description: 'Task ready for Foundry to claim' },
  { name: 'state:in-progress', color: 'fbca04', description: 'Task claimed by Foundry runner' },
  { name: 'state:done', color: '5319e7', description: 'Task completed by Foundry' },
  { name: 'state:ready-for-human-review', color: '1d76db', description: 'Ready for human review' },
  { name: 'spec:changed', color: 'd93f0b', description: 'Specification changed — replan needed' },
  { name: 'agent:claude', color: 'c5def5', description: 'Use Claude Code agent backend' },
  { name: 'agent:cursor', color: 'c5def5', description: 'Use Cursor agent backend' },
];

function detectRepo(): string {
  try {
    const remoteUrl = git.repoRoot(); // just to verify we're in a git repo
    const { execFileSync } = require('node:child_process');
    const remote = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    return remote;
  } catch {
    return 'OWNER/REPO';
  }
}

const DEFAULT_CONFIG = {
  repo: '',
  labels: {
    ready: 'state:ready',
    in_progress: 'state:in-progress',
    done: 'state:done',
    ready_for_review: 'state:ready-for-human-review',
    spec_changed: 'spec:changed',
  },
  branch_template: 'feature/{issue}-{slug}',
  worktree_base: './wts',
  tmux_template: 'foundry-{issue}',
  max_sessions: 4,
  max_verify_parallel: 1,
  verify: [
    'npm run lint',
    'npm run typecheck',
    'npm run build',
    'npm test',
  ],
  integration_rebuild: 'npm run build',
  comment_triggers: {
    replan: '@foundry replan',
    restart: '@foundry restart',
  },
  version_sources: [
    'package.json',
  ],
  tag_prefix: 'v',
  poll_interval_seconds: 30,
  default_agent_backend: 'claude-code',
  agent_backends: {
    'claude-code': {
      type: 'command',
      command: 'claude --dangerously-skip-permissions -p "You are working on issue #{issue_number}: {title}. The issue is at {issue_url}. Read the issue body and implement the task. When done, create a commit with your changes." --output-format stream-json 2>&1 | tee {log_dir}/agent.log',
    },
    command: {
      type: 'command',
      command: 'echo "Configure your agent command in .joynt-foundry.yml"',
    },
  },
  agent_label_map: {
    'agent:claude': 'claude-code',
  },
};

export async function runInit(opts: { skipLabels?: boolean }): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);

  if (fs.existsSync(configPath)) {
    log.warn(`${CONFIG_FILENAME} already exists. Skipping scaffold.`);
  } else {
    const repo = detectRepo();
    const config = { ...DEFAULT_CONFIG, repo };
    const yaml = toYaml(config, { lineWidth: 120 });
    fs.writeFileSync(configPath, yaml, 'utf-8');
    log.success(`Created ${CONFIG_FILENAME}`);
  }

  if (!opts.skipLabels) {
    log.info('Creating GitHub labels...');
    const repo = detectRepo();
    for (const label of LABEL_DEFS) {
      try {
        github.ensureLabel(repo, label.name, label.color, label.description);
        log.success(`  Label: ${label.name}`);
      } catch (err) {
        log.warn(`  Failed to create label ${label.name}: ${err}`);
      }
    }
  }

  log.info('');
  log.info('Next steps:');
  log.info('  1. Review and edit .joynt-foundry.yml');
  log.info('  2. Configure version_sources with paths to your package.json files');
  log.info('  3. Configure agent_backends for your preferred coding agent');
  log.info('  4. Run `foundry run` to start the runner loop');
  log.info('');
  log.info('Docs: docs/foundry/overview.md');
}
