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
  { name: 'state:waiting-for-input', color: 'e4e669', description: 'Agent needs human input to proceed' },
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

// ── Project type detection ──────────────────────────────────────────────

interface ProjectDefaults {
  verify: string[];
  integration_rebuild: string;
  version_sources: string[];
}

function detectProjectDefaults(): ProjectDefaults & { detected: string } {
  const cwd = process.cwd();

  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return {
      detected: 'Node.js',
      verify: ['npm run lint', 'npm run typecheck', 'npm run build', 'npm test'],
      integration_rebuild: 'npm run build',
      version_sources: ['package.json'],
    };
  }

  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    return {
      detected: 'Python',
      verify: ['python -m pytest'],
      integration_rebuild: '',
      version_sources: ['pyproject.toml'],
    };
  }

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return {
      detected: 'Rust',
      verify: ['cargo check', 'cargo test'],
      integration_rebuild: 'cargo build --release',
      version_sources: ['Cargo.toml'],
    };
  }

  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return {
      detected: 'Go',
      verify: ['go vet ./...', 'go test ./...'],
      integration_rebuild: 'go build ./...',
      version_sources: [],
    };
  }

  return {
    detected: 'unknown',
    verify: [],
    integration_rebuild: '',
    version_sources: [],
  };
}

// ── Default config (language-agnostic) ──────────────────────────────────

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
  verify: [] as string[],
  integration_rebuild: '',
  comment_triggers: {
    replan: '@foundry replan',
    restart: '@foundry restart',
  },
  version_sources: [] as string[],
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

export async function runInit(opts: { skipLabels?: boolean; cleanLabels?: boolean }): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);

  if (fs.existsSync(configPath)) {
    log.warn(`${CONFIG_FILENAME} already exists. Skipping scaffold.`);
  } else {
    const repo = detectRepo();
    const projectDefaults = detectProjectDefaults();

    if (projectDefaults.detected !== 'unknown') {
      log.info(`Detected ${projectDefaults.detected} project`);
    } else {
      log.info('No recognized project marker found — using empty defaults');
    }

    const { detected: _, ...defaults } = projectDefaults;
    const config = { ...DEFAULT_CONFIG, ...defaults, repo };
    const yaml = toYaml(config, { lineWidth: 120 });
    fs.writeFileSync(configPath, yaml, 'utf-8');
    log.success(`Created ${CONFIG_FILENAME}`);
  }

  // Auto-commit on empty repo so we have a HEAD for branch creation
  if (!git.hasCommits()) {
    log.info('Empty repository detected — creating initial commit...');
    git.commitAll('chore: initialize foundry config');
    log.success('Created initial commit with .joynt-foundry.yml');
  }

  // Create integration branch if it doesn't exist
  if (!git.remoteBranchExists('integration') && !git.branchExists('integration')) {
    log.info('Creating integration branch...');
    try {
      const prev = git.currentBranch();
      git.createBranch('integration', 'HEAD');
      git.push('integration');
      git.checkout(prev);
      log.success('Created and pushed integration branch');
    } catch (err) {
      log.warn(`Failed to create integration branch: ${err}`);
    }
  } else {
    log.info('Integration branch already exists.');
  }

  if (!opts.skipLabels) {
    const repo = detectRepo();

    if (opts.cleanLabels) {
      log.info('Removing non-Foundry labels...');
      const foundryNames = new Set(LABEL_DEFS.map(l => l.name));
      const existing = github.listLabels(repo);
      for (const name of existing) {
        if (!foundryNames.has(name)) {
          try {
            github.deleteLabel(repo, name);
            log.success(`  Deleted label: ${name}`);
          } catch (err) {
            log.warn(`  Failed to delete label ${name}: ${err}`);
          }
        }
      }
    }

    log.info('Creating GitHub labels...');
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
  log.info('  2. Configure version_sources and agent_backends');
  log.info('  3. Run `foundry run` to start the runner loop');
  log.info('');
  log.info('Docs: docs/foundry/overview.md');
}
