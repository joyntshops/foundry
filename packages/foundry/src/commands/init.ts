/**
 * foundry init — scaffold .joynt-foundry.yml and create required labels.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { CONFIG_FILENAME, loadConfig, loadConfigSafe } from '../config.js';
import * as github from '../lib/github.js';
import * as log from '../lib/log.js';
import * as git from '../lib/git.js';

const LABEL_DEFS: Array<{ name: string; color: string; description: string }> = [
  { name: 'state:in-progress', color: 'fbca04', description: 'Foundry is working on this issue' },
  { name: 'state:done', color: '006b75', description: 'Task completed by Foundry' },
  { name: 'state:ready-for-human-review', color: '1d76db', description: 'Ready for human review' },
  { name: 'state:waiting-for-input', color: '1d76db', description: 'Agent needs human input to proceed' },
  { name: 'state:failed', color: 'b60205', description: 'Task failed — needs human review before retry' },
  { name: 'state:plan-review', color: '1d76db', description: 'Agent plan awaiting human review' },
  { name: 'mode:plan', color: '5319e7', description: 'Agent runs in plan-only mode' },
  { name: 'mode:auto', color: '5319e7', description: 'Agent runs with full permissions' },
  { name: 'mode:default', color: '5319e7', description: 'Agent runs in step-by-step mode' },
];

async function detectRepo(): Promise<string> {
  try {
    git.repoRoot(); // just to verify we're in a git repo
    return await github.getRepoSlug();
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
    in_progress: 'state:in-progress',
    done: 'state:done',
    ready_for_review: 'state:ready-for-human-review',
    waiting_for_input: 'state:waiting-for-input',
    failed: 'state:failed',
    plan_review: 'state:plan-review',
  },
  mode_labels: {
    plan: 'mode:plan',
    auto: 'mode:auto',
    default: 'mode:default',
  },
  branches: {
    integration: 'integration',
    production: 'main',
  },
  branch_template: 'feature/{issue}-{slug}',
  worktree_base: './wts',
  verify: [] as string[],
  verify_preview: [] as string[],
  integration_rebuild: '',
  comment_triggers: {
    go: '@foundry go',
    restart: '@foundry restart',
    stop: '@foundry stop',
  },
  version_sources: [] as string[],
  tag_prefix: 'v',
  default_agent_backend: 'claude-code',
  agent_backends: {
    'claude-code': {
      type: 'command',
      preset: 'claude-code',
    },
    command: {
      type: 'command',
      command: 'echo "Configure your agent command in .joynt-foundry.yml"',
    },
  },
  agent_label_map: {
    'agent:claude': 'claude-code',
  },
  github_backend: 'octokit' as const,
};

export async function runInit(opts: { skipLabels?: boolean; cleanLabels?: boolean }): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);

  if (fs.existsSync(configPath)) {
    log.warn(`${CONFIG_FILENAME} already exists. Skipping scaffold.`);
  } else {
    const repo = await detectRepo();
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

  writeIssueTemplate();

  // Auto-commit on empty repo so we have a HEAD for branch creation
  if (!git.hasCommits()) {
    log.info('Empty repository detected — creating initial commit...');
    git.commitAll('chore: initialize foundry config');
    log.success('Created initial commit with .joynt-foundry.yml');
  }

  // Create the integration branch if it doesn't exist
  const integration = loadConfigSafe()?.branches?.integration ?? 'integration';
  if (!git.remoteBranchExists(integration) && !git.branchExists(integration)) {
    log.info(`Creating ${integration} branch...`);
    try {
      const prev = git.currentBranch();
      git.createBranch(integration, 'HEAD');
      git.push(integration);
      git.checkout(prev);
      log.success(`Created and pushed ${integration} branch`);
    } catch (err) {
      log.warn(`Failed to create ${integration} branch: ${err}`);
    }
  } else {
    log.info(`Integration branch ${integration} already exists.`);
  }

  if (!opts.skipLabels) {
    const repo = await detectRepo();
    const config = loadConfig();

    // Derive agent labels dynamically when 2+ entries exist in agent_label_map
    const allLabels = [...LABEL_DEFS];
    const agentMap = config.agent_label_map ?? {};
    if (Object.keys(agentMap).length >= 2) {
      for (const labelName of Object.keys(agentMap)) {
        allLabels.push({ name: labelName, color: 'c5def5', description: `Use ${agentMap[labelName]} agent backend` });
      }
    }

    if (opts.cleanLabels) {
      log.info('Removing non-Foundry labels...');
      const foundryNames = new Set(allLabels.map(l => l.name));
      const existing = await github.listLabels(repo);
      for (const name of existing) {
        if (!foundryNames.has(name)) {
          try {
            await github.deleteLabel(repo, name);
            log.success(`  Deleted label: ${name}`);
          } catch (err) {
            log.warn(`  Failed to delete label ${name}: ${err}`);
          }
        }
      }
    }

    log.info('Creating GitHub labels...');
    for (const label of allLabels) {
      try {
        await github.ensureLabel(repo, label.name, label.color, label.description);
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

const ISSUE_TEMPLATE = `---
name: Foundry task
about: A task for the coding agent. Comment "@foundry go" when it is ready to start.
labels: []
---

## What
<!-- One or two sentences. What should exist when this is done? -->

## Acceptance criteria
<!-- Bullet points the reviewer will check. Be concrete. -->
-

## Constraints
<!-- Files or areas not to touch, conventions to follow, things to avoid. -->
-

## Out of scope
<!-- What a reasonable developer might include but should not. -->
-

<!--
Start: comment "@foundry go". Nothing happens until you do.
Mode: add the label mode:plan first to get a plan for approval before any code is written.
Every comment on this issue is given to the agent; only "@foundry go" starts it.
The agent decides small things itself and lists them in the PR; it asks only when an answer changes the work.
-->
`;

/** Scaffold the issue template that gives the agent a developer-quality brief. */
function writeIssueTemplate(): void {
  const dir = path.join(process.cwd(), '.github', 'ISSUE_TEMPLATE');
  const file = path.join(dir, 'foundry-task.md');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, ISSUE_TEMPLATE, 'utf-8');
  log.success('Created .github/ISSUE_TEMPLATE/foundry-task.md');
}
