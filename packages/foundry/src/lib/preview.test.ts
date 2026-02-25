/**
 * Preview module tests — mock external modules to verify URL resolution,
 * comment upsert, deployment coordination, and provider command execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FoundryConfig, TaskState } from '../types.js';

// ── Mock external modules ───────────────────────────────────────────────

vi.mock('./github.js', () => ({
  getComments: vi.fn(),
  updateComment: vi.fn(),
  commentOnPR: vi.fn(),
}));

vi.mock('./state.js', () => ({
  getAllTasks: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

vi.mock('./deployments.js', () => ({
  createDeployment: vi.fn(),
  createDeploymentStatus: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('./log.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

import { previewUp, previewDown, getPreviewStatus } from './preview.js';
import * as github from './github.js';
import * as state from './state.js';
import * as deployments from './deployments.js';
import { execSync } from 'node:child_process';

// ── Helper factories ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<FoundryConfig> = {}): FoundryConfig {
  return {
    repo: 'acme/webapp',
    labels: {
      ready: 'state:ready',
      in_progress: 'state:in-progress',
      done: 'state:done',
      ready_for_review: 'state:ready-for-human-review',
      waiting_for_input: 'state:waiting-for-input',
      failed: 'state:failed',
      plan_review: 'state:plan-review',
      claim: 'state:claim',
    },
    branch_template: 'feature/{issue}-{slug}',
    worktree_base: '../wts',
    tmux_template: 'foundry-{issue}',
    max_sessions: 4,
    max_verify_parallel: 1,
    max_input_rounds: 3,
    verify: ['npm test'],
    integration_rebuild: 'npm run build',
    comment_triggers: {
      replan: '@foundry replan',
      restart: '@foundry restart',
      stop: '@foundry stop',
      continue: '@foundry continue',
      plan: '@foundry plan',
      start: '@foundry start',
      claim: '@foundry claim',
    },
    version_sources: ['package.json'],
    tag_prefix: 'v',
    default_agent_backend: 'command',
    agent_backends: {
      command: { type: 'command', command: 'echo hello' },
    },
    poll_interval_seconds: 30,
    github_backend: 'gh-cli',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    issue: 42,
    title: 'Fix login bug',
    repo: 'acme/webapp',
    branch: 'feature/42-fix-login',
    worktree: '/tmp/wts/42',
    tmux_session: 'foundry-42',
    agent_backend: 'command',
    status: 'pr-open',
    claimed_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T01:00:00Z',
    runner_id: 'runner-1',
    pr_number: 99,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no existing comments
  vi.mocked(github.getComments).mockResolvedValue([]);
  vi.mocked(github.commentOnPR).mockResolvedValue(undefined);
  vi.mocked(github.updateComment).mockResolvedValue(undefined);
});

describe('previewUp', () => {
  describe('template mode', () => {
    it('expands url_template and saves preview_url to state', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://pr-42.example.com' },
      );
    });

    it('expands branch and repo variables in template', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://{branch}.{repo}.preview.dev',
        },
      });
      const task = makeTask({ branch: 'feat-42' });

      await previewUp(config, task);

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://feat-42.acme/webapp.preview.dev' },
      );
    });

    it('posts a new comment on the PR', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(github.commentOnPR).toHaveBeenCalledWith(
        'acme/webapp',
        99,
        expect.stringContaining('https://pr-42.example.com'),
      );
      expect(github.commentOnPR).toHaveBeenCalledWith(
        'acme/webapp',
        99,
        expect.stringContaining('<!-- foundry-preview -->'),
      );
    });

    it('does not create a deployment when github_deployments is not enabled', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(deployments.createDeployment).not.toHaveBeenCalled();
      expect(deployments.createDeploymentStatus).not.toHaveBeenCalled();
    });

    it('does not post comment when config.preview.comment is false', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
          comment: false,
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(github.getComments).not.toHaveBeenCalled();
      expect(github.commentOnPR).not.toHaveBeenCalled();
    });

    it('does not post comment when task has no pr_number', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask({ pr_number: undefined });

      await previewUp(config, task);

      expect(github.getComments).not.toHaveBeenCalled();
      expect(github.commentOnPR).not.toHaveBeenCalled();
    });
  });

  describe('provider mode', () => {
    it('calls execSync with expanded command and correct env vars', async () => {
      vi.mocked(execSync).mockReturnValue('https://dynamic-preview.example.com\n');

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy --branch {branch} --issue {issue}',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(execSync).toHaveBeenCalledWith(
        'deploy --branch feature/42-fix-login --issue 42',
        expect.objectContaining({
          encoding: 'utf-8',
          timeout: 120_000,
          env: expect.objectContaining({
            FOUNDRY_BRANCH: 'feature/42-fix-login',
            FOUNDRY_ISSUE: '42',
            FOUNDRY_REPO: 'acme/webapp',
            FOUNDRY_PR_NUMBER: '99',
          }),
        }),
      );
    });

    it('captures plain URL from command output', async () => {
      vi.mocked(execSync).mockReturnValue('https://preview-42.example.com\n');

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy-preview',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://preview-42.example.com' },
      );
    });

    it('parses JSON output with url field', async () => {
      vi.mocked(execSync).mockReturnValue(
        JSON.stringify({ url: 'https://json-preview.example.com', id: 'abc' }),
      );

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy-preview --json',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://json-preview.example.com' },
      );
    });

    it('returns early when command output is not a URL', async () => {
      vi.mocked(execSync).mockReturnValue('some random output\n');

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy-preview',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).not.toHaveBeenCalled();
      expect(github.commentOnPR).not.toHaveBeenCalled();
    });

    it('returns early when command throws', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('command failed');
      });

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy-preview',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('falls back to url_template when command output is not a URL', async () => {
      vi.mocked(execSync).mockReturnValue('deploy successful\n');

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy-preview',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://pr-42.example.com' },
      );
    });

    it('falls back to url_template when command throws', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('command failed');
      });

      const config = makeConfig({
        preview: {
          mode: 'provider',
          up_command: 'deploy-preview',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://pr-42.example.com' },
      );
    });

    it('uses url_template when up_command is not set', async () => {
      const config = makeConfig({
        preview: {
          mode: 'provider',
          url_template: 'https://pr-{issue}.example.com',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(execSync).not.toHaveBeenCalled();
      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { preview_url: 'https://pr-42.example.com' },
      );
    });

    it('does nothing when neither up_command nor url_template is set', async () => {
      const config = makeConfig({
        preview: {
          mode: 'provider',
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(execSync).not.toHaveBeenCalled();
      expect(state.updateTaskStatus).not.toHaveBeenCalled();
    });
  });

  describe('with deployments enabled', () => {
    it('creates deployment and deployment status on success', async () => {
      vi.mocked(deployments.createDeployment).mockResolvedValue({ id: 777 });
      vi.mocked(deployments.createDeploymentStatus).mockResolvedValue(undefined);

      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
        github_deployments: {
          enabled: true,
          environment: 'staging',
          production: false,
          auto_inactive: true,
        },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(deployments.createDeployment).toHaveBeenCalledWith({
        repo: 'acme/webapp',
        ref: 'feature/42-fix-login',
        environment: 'staging',
        description: 'Preview for #42',
        transientEnvironment: true,
        productionEnvironment: false,
      });

      expect(deployments.createDeploymentStatus).toHaveBeenCalledWith({
        repo: 'acme/webapp',
        deploymentId: 777,
        state: 'success',
        environmentUrl: 'https://pr-42.example.com',
        description: 'Preview is live',
        autoInactive: true,
      });
    });

    it('saves deployment_id to task state', async () => {
      vi.mocked(deployments.createDeployment).mockResolvedValue({ id: 555 });
      vi.mocked(deployments.createDeploymentStatus).mockResolvedValue(undefined);

      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
        github_deployments: { enabled: true },
      });
      const task = makeTask();

      await previewUp(config, task);

      // First call saves preview_url, second saves deployment_id
      expect(state.updateTaskStatus).toHaveBeenCalledWith(
        'acme/webapp',
        42,
        'pr-open',
        { deployment_id: 555 },
      );
    });

    it('uses default environment "preview" when not configured', async () => {
      vi.mocked(deployments.createDeployment).mockResolvedValue({ id: 1 });
      vi.mocked(deployments.createDeploymentStatus).mockResolvedValue(undefined);

      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
        github_deployments: { enabled: true },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(deployments.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'preview' }),
      );
    });

    it('skips deployment status when createDeployment returns null', async () => {
      vi.mocked(deployments.createDeployment).mockResolvedValue(null);

      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
        github_deployments: { enabled: true },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(deployments.createDeploymentStatus).not.toHaveBeenCalled();
    });

    it('does not create deployment when github_deployments.enabled is false', async () => {
      const config = makeConfig({
        preview: {
          mode: 'template',
          url_template: 'https://pr-{issue}.example.com',
        },
        github_deployments: { enabled: false },
      });
      const task = makeTask();

      await previewUp(config, task);

      expect(deployments.createDeployment).not.toHaveBeenCalled();
    });
  });

  it('no-ops when config.preview is undefined', async () => {
    const config = makeConfig({ preview: undefined });
    const task = makeTask();

    await previewUp(config, task);

    expect(state.updateTaskStatus).not.toHaveBeenCalled();
    expect(github.commentOnPR).not.toHaveBeenCalled();
    expect(deployments.createDeployment).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe('previewDown', () => {
  it('executes down_command in provider mode', async () => {
    vi.mocked(execSync).mockReturnValue('');

    const config = makeConfig({
      preview: {
        mode: 'provider',
        down_command: 'teardown --branch {branch}',
      },
    });
    const task = makeTask({ preview_url: 'https://preview-42.example.com' });

    await previewDown(config, task);

    expect(execSync).toHaveBeenCalledWith(
      'teardown --branch feature/42-fix-login',
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 120_000,
        env: expect.objectContaining({
          FOUNDRY_BRANCH: 'feature/42-fix-login',
          FOUNDRY_ISSUE: '42',
        }),
      }),
    );
  });

  it('sets deployment status to inactive', async () => {
    vi.mocked(deployments.createDeploymentStatus).mockResolvedValue(undefined);

    const config = makeConfig({
      preview: { mode: 'template' },
      github_deployments: { enabled: true, auto_inactive: false },
    });
    const task = makeTask({
      preview_url: 'https://preview-42.example.com',
      deployment_id: 777,
    });

    await previewDown(config, task);

    expect(deployments.createDeploymentStatus).toHaveBeenCalledWith({
      repo: 'acme/webapp',
      deploymentId: 777,
      state: 'inactive',
      description: 'Preview torn down',
      autoInactive: false,
    });
  });

  it('updates PR comment to show inactive state', async () => {
    vi.mocked(github.getComments).mockResolvedValue([]);

    const config = makeConfig({
      preview: { mode: 'template' },
    });
    const task = makeTask({ preview_url: 'https://preview-42.example.com' });

    await previewDown(config, task);

    expect(github.commentOnPR).toHaveBeenCalledWith(
      'acme/webapp',
      99,
      expect.stringContaining('inactive'),
    );
    expect(github.commentOnPR).toHaveBeenCalledWith(
      'acme/webapp',
      99,
      expect.stringContaining('Torn down'),
    );
  });

  it('no-ops when config.preview is undefined', async () => {
    const config = makeConfig({ preview: undefined });
    const task = makeTask({ preview_url: 'https://preview-42.example.com' });

    await previewDown(config, task);

    expect(execSync).not.toHaveBeenCalled();
    expect(deployments.createDeploymentStatus).not.toHaveBeenCalled();
    expect(github.getComments).not.toHaveBeenCalled();
  });

  it('no-ops when task has no preview_url', async () => {
    const config = makeConfig({
      preview: { mode: 'provider', down_command: 'teardown' },
    });
    const task = makeTask({ preview_url: undefined });

    await previewDown(config, task);

    expect(execSync).not.toHaveBeenCalled();
    expect(deployments.createDeploymentStatus).not.toHaveBeenCalled();
    expect(github.getComments).not.toHaveBeenCalled();
  });

  it('does not run down_command in template mode', async () => {
    const config = makeConfig({
      preview: { mode: 'template', down_command: 'teardown' },
    });
    const task = makeTask({ preview_url: 'https://preview-42.example.com' });

    await previewDown(config, task);

    expect(execSync).not.toHaveBeenCalled();
  });

  it('does not set deployment status when deployment_id is absent', async () => {
    const config = makeConfig({
      preview: { mode: 'template' },
      github_deployments: { enabled: true },
    });
    const task = makeTask({
      preview_url: 'https://preview-42.example.com',
      deployment_id: undefined,
    });

    await previewDown(config, task);

    expect(deployments.createDeploymentStatus).not.toHaveBeenCalled();
  });

  it('continues even if down_command throws', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('teardown failed');
    });

    const config = makeConfig({
      preview: {
        mode: 'provider',
        down_command: 'teardown',
      },
      github_deployments: { enabled: true },
    });
    const task = makeTask({
      preview_url: 'https://preview-42.example.com',
      deployment_id: 100,
    });

    // Should not throw
    await previewDown(config, task);

    // Deployment status should still be updated
    expect(deployments.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'inactive' }),
    );
  });
});

describe('getPreviewStatus', () => {
  it('returns "none" when config.preview is undefined', () => {
    const config = makeConfig({ preview: undefined });
    const task = makeTask({ preview_url: 'https://preview.example.com' });

    const result = getPreviewStatus(config, task);
    expect(result).toEqual({ url: null, deploymentId: null, state: 'none' });
  });

  it('returns "none" when task has no preview_url', () => {
    const config = makeConfig({ preview: { mode: 'template' } });
    const task = makeTask({ preview_url: undefined });

    const result = getPreviewStatus(config, task);
    expect(result).toEqual({ url: null, deploymentId: null, state: 'none' });
  });

  it.each([
    'pr-open' as const,
    'reviewing' as const,
    'pr-changes-requested' as const,
    'agent-running' as const,
    'verifying' as const,
  ])('returns "active" for status "%s"', (taskStatus) => {
    const config = makeConfig({ preview: { mode: 'template' } });
    const task = makeTask({
      status: taskStatus,
      preview_url: 'https://preview.example.com',
      deployment_id: 10,
    });

    const result = getPreviewStatus(config, task);
    expect(result).toEqual({
      url: 'https://preview.example.com',
      deploymentId: 10,
      state: 'active',
    });
  });

  it.each([
    'done' as const,
    'failed' as const,
    'stopped' as const,
    'claimed' as const,
    'waiting-for-input' as const,
  ])('returns "inactive" for status "%s"', (taskStatus) => {
    const config = makeConfig({ preview: { mode: 'template' } });
    const task = makeTask({
      status: taskStatus,
      preview_url: 'https://preview.example.com',
    });

    const result = getPreviewStatus(config, task);
    expect(result).toEqual({
      url: 'https://preview.example.com',
      deploymentId: null,
      state: 'inactive',
    });
  });

  it('includes deployment_id when present on task', () => {
    const config = makeConfig({ preview: { mode: 'template' } });
    const task = makeTask({
      status: 'pr-open',
      preview_url: 'https://preview.example.com',
      deployment_id: 999,
    });

    const result = getPreviewStatus(config, task);
    expect(result.deploymentId).toBe(999);
  });
});

describe('comment upsert', () => {
  it('updates existing comment when marker is found', async () => {
    vi.mocked(github.getComments).mockResolvedValue([
      {
        id: 501,
        body: '<!-- foundry-preview -->\n**Preview Environment** — Live\n\nhttps://old.example.com',
        user: { login: 'foundry-bot' },
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const config = makeConfig({
      preview: {
        mode: 'template',
        url_template: 'https://pr-{issue}.example.com',
      },
    });
    const task = makeTask();

    await previewUp(config, task);

    expect(github.updateComment).toHaveBeenCalledWith(
      'acme/webapp',
      501,
      expect.stringContaining('https://pr-42.example.com'),
    );
    expect(github.commentOnPR).not.toHaveBeenCalled();
  });

  it('creates new comment when no existing comment with marker', async () => {
    vi.mocked(github.getComments).mockResolvedValue([
      {
        id: 100,
        body: 'Regular comment without marker',
        user: { login: 'someone' },
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const config = makeConfig({
      preview: {
        mode: 'template',
        url_template: 'https://pr-{issue}.example.com',
      },
    });
    const task = makeTask();

    await previewUp(config, task);

    expect(github.updateComment).not.toHaveBeenCalled();
    expect(github.commentOnPR).toHaveBeenCalledWith(
      'acme/webapp',
      99,
      expect.stringContaining('<!-- foundry-preview -->'),
    );
  });

  it('updates existing comment on previewDown', async () => {
    vi.mocked(github.getComments).mockResolvedValue([
      {
        id: 501,
        body: '<!-- foundry-preview -->\n**Preview Environment** — Live\n\nhttps://preview.example.com',
        user: { login: 'foundry-bot' },
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const config = makeConfig({
      preview: { mode: 'template' },
    });
    const task = makeTask({ preview_url: 'https://preview.example.com' });

    await previewDown(config, task);

    expect(github.updateComment).toHaveBeenCalledWith(
      'acme/webapp',
      501,
      expect.stringContaining('Torn down'),
    );
    expect(github.commentOnPR).not.toHaveBeenCalled();
  });
});
