/**
 * Preview orchestration — URL resolution, provider command execution,
 * comment upsert, and GitHub Deployment coordination.
 */
import { execSync } from 'node:child_process';
import * as github from './github.js';
import * as state from './state.js';
import * as deployments from './deployments.js';
import * as log from './log.js';
import type { FoundryConfig, TaskState } from '../types.js';

const COMMENT_MARKER = '<!-- foundry-preview -->';

// ── Template variable expansion ──────────────────────────────────────────

interface TemplateVars {
  branch: string;
  issue: number;
  repo: string;
  pr_number: number | undefined;
  sha: string;
}

function expandTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{issue\}/g, String(vars.issue))
    .replace(/\{repo\}/g, vars.repo)
    .replace(/\{pr_number\}/g, String(vars.pr_number ?? ''))
    .replace(/\{sha\}/g, vars.sha);
}

function makeEnvVars(vars: TemplateVars): Record<string, string> {
  return {
    FOUNDRY_BRANCH: vars.branch,
    FOUNDRY_ISSUE: String(vars.issue),
    FOUNDRY_REPO: vars.repo,
    FOUNDRY_PR_NUMBER: String(vars.pr_number ?? ''),
    FOUNDRY_SHA: vars.sha,
  };
}

function resolveHeadSha(worktree: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: worktree, encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {
    return '';
  }
}

// ── URL resolution ───────────────────────────────────────────────────────

function resolveTemplateUrl(config: FoundryConfig, vars: TemplateVars): string | null {
  if (!config.preview?.url_template) return null;
  return expandTemplate(config.preview.url_template, vars);
}

/**
 * Run the provider's up command. Returns the URL it printed, or null.
 *
 * When `expectUrl` is false the caller has a url_template and only needs the
 * command to run; its output is ignored and no warning is logged about it.
 * This matters because commands like `gh workflow run` print an Actions run
 * URL, which is a URL but not the preview.
 */
function runProviderCommand(command: string, vars: TemplateVars, expectUrl: boolean): string | null {
  const expanded = expandTemplate(command, vars);
  const env = { ...process.env, ...makeEnvVars(vars) };

  try {
    const output = execSync(expanded, {
      encoding: 'utf-8',
      timeout: 120_000,
      env,
    }).trim();

    if (!expectUrl) return null;

    // Try to parse as JSON with a `url` field
    try {
      const parsed = JSON.parse(output);
      if (parsed.url) return parsed.url;
    } catch {
      // Not JSON — treat entire output as URL
    }

    // Validate it looks like a URL
    if (output.startsWith('http://') || output.startsWith('https://')) {
      return output.split('\n').pop()!.trim();
    }

    log.warn(`Provider command output does not look like a URL: ${output.slice(0, 200)}`);
    return null;
  } catch (err: any) {
    log.warn(`Provider up command failed: ${err.message}`);
    return null;
  }
}

// ── Comment upsert ───────────────────────────────────────────────────────

function buildPreviewComment(url: string, state: 'active' | 'inactive'): string {
  const status = state === 'active' ? 'Live' : 'Torn down';
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return [
    COMMENT_MARKER,
    `**Preview Environment** — ${status}`,
    '',
    state === 'active' ? `Preview URL: ${url}` : `~~${url}~~ (inactive)`,
    '',
    `_Updated: ${timestamp}_`,
  ].join('\n');
}

async function upsertPreviewComment(
  repo: string,
  prNumber: number,
  url: string,
  commentState: 'active' | 'inactive',
): Promise<void> {
  const body = buildPreviewComment(url, commentState);

  try {
    const comments = await github.getComments(repo, prNumber);
    const existing = comments.find(c => c.body.includes(COMMENT_MARKER));

    if (existing) {
      await github.updateComment(repo, existing.id, body);
    } else {
      await github.commentOnPR(repo, prNumber, body);
    }
  } catch (err: any) {
    log.warn(`Failed to upsert preview comment on PR #${prNumber}: ${err.message}`);
  }
}

// ── Main exports ─────────────────────────────────────────────────────────

export async function previewUp(config: FoundryConfig, task: TaskState): Promise<void> {
  if (!config.preview) return;

  const vars: TemplateVars = {
    branch: task.branch,
    issue: task.issue,
    repo: config.repo,
    pr_number: task.pr_number,
    sha: resolveHeadSha(task.worktree),
  };

  // Resolve URL. url_template, when set, is always the preview URL: the
  // provider command still runs (it does the deploy) but its output is not
  // consulted. Only without a template do we read the URL from the command.
  const hasTemplate = Boolean(config.preview.url_template);
  let url: string | null = null;

  if (config.preview.mode === 'provider' && config.preview.up_command) {
    url = runProviderCommand(config.preview.up_command, vars, !hasTemplate);
  }

  if (hasTemplate) {
    url = resolveTemplateUrl(config, vars);
  }

  if (!url) {
    log.warn(`Preview up: could not resolve URL for #${task.issue}`);
    return;
  }

  // Save preview URL to state
  state.updateTaskStatus(config.repo, task.issue, task.status, {
    preview_url: url,
  });

  log.info(`Preview URL for #${task.issue}: ${url}`);

  // Create GitHub Deployment (if enabled)
  let deploymentId: number | undefined;
  if (config.github_deployments?.enabled) {
    const deployment = await deployments.createDeployment({
      repo: config.repo,
      ref: task.branch,
      environment: config.github_deployments.environment ?? 'preview',
      description: `Preview for #${task.issue}`,
      transientEnvironment: !(config.github_deployments.production ?? false),
      productionEnvironment: config.github_deployments.production ?? false,
    });

    if (deployment) {
      deploymentId = deployment.id;
      state.updateTaskStatus(config.repo, task.issue, task.status, {
        deployment_id: deploymentId,
      });

      await deployments.createDeploymentStatus({
        repo: config.repo,
        deploymentId: deployment.id,
        state: 'success',
        environmentUrl: url,
        description: 'Preview is live',
        autoInactive: config.github_deployments.auto_inactive ?? true,
      });
    }
  }

  // Post/update PR comment
  if (config.preview.comment !== false && task.pr_number) {
    await upsertPreviewComment(config.repo, task.pr_number, url, 'active');
  }
}

export async function previewDown(config: FoundryConfig, task: TaskState): Promise<void> {
  if (!config.preview) return;
  if (!task.preview_url) return;

  const vars: TemplateVars = {
    branch: task.branch,
    issue: task.issue,
    repo: config.repo,
    pr_number: task.pr_number,
    sha: resolveHeadSha(task.worktree),
  };

  // Run down command (provider mode only)
  if (config.preview.mode === 'provider' && config.preview.down_command) {
    const expanded = expandTemplate(config.preview.down_command, vars);
    const env = { ...process.env, ...makeEnvVars(vars) };
    try {
      execSync(expanded, { encoding: 'utf-8', timeout: 120_000, env });
    } catch (err: any) {
      log.warn(`Preview down command failed for #${task.issue}: ${err.message}`);
    }
  }

  // Set deployment status to inactive
  if (config.github_deployments?.enabled && task.deployment_id) {
    await deployments.createDeploymentStatus({
      repo: config.repo,
      deploymentId: task.deployment_id,
      state: 'inactive',
      description: 'Preview torn down',
      autoInactive: config.github_deployments.auto_inactive ?? true,
    });
  }

  // Update PR comment
  if (config.preview.comment !== false && task.pr_number) {
    await upsertPreviewComment(config.repo, task.pr_number, task.preview_url, 'inactive');
  }

  log.info(`Preview torn down for #${task.issue}`);
}

export interface PreviewStatus {
  url: string | null;
  deploymentId: number | null;
  state: 'active' | 'inactive' | 'none';
}

export function getPreviewStatus(config: FoundryConfig, task: TaskState): PreviewStatus {
  if (!config.preview || !task.preview_url) {
    return { url: null, deploymentId: null, state: 'none' };
  }

  const isActive = ['pr-open', 'reviewing', 'pr-changes-requested', 'agent-running', 'verifying'].includes(task.status);

  return {
    url: task.preview_url,
    deploymentId: task.deployment_id ?? null,
    state: isActive ? 'active' : 'inactive',
  };
}
