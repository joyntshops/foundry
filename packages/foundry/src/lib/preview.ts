/**
 * Preview orchestration — URL resolution, provider command execution,
 * comment upsert, and GitHub Deployment coordination.
 */
import { execSync } from 'node:child_process';
import { runCommand, describeFailure } from './run-command.js';
import { DEFAULT_READY_TIMEOUT_S } from './preview-verify.js';
import * as github from './github.js';
import * as state from './state.js';
import * as deployments from './deployments.js';
import * as log from './log.js';
import type { FoundryConfig, TaskState } from '../types.js';
import { slugify } from './git.js';

const COMMENT_MARKER = '<!-- foundry-preview -->';
/** Machine-readable expiry inside the preview comment; jobs are stateless, so the comment is the record. */
const EXPIRES_RE = /<!-- foundry-preview-expires: (\S+) -->/;

// ── Trigger and expiry ───────────────────────────────────────────────────

/** `preview.trigger: on_demand`: nothing deploys until someone asks with the preview command. */
export function isOnDemand(config: FoundryConfig): boolean {
  return config.preview?.trigger === 'on_demand';
}

/** When a preview deployed now expires, from `preview.ttl_hours`. Undefined: it does not. */
export function expiryFor(config: FoundryConfig, now: Date = new Date()): string | undefined {
  const hours = config.preview?.ttl_hours;
  if (typeof hours !== 'number' || !(hours > 0)) return undefined;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

export function isExpired(expiresAt: string | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t <= now.getTime();
}

/** Why a preview is being taken down; decides what its comment says afterwards. */
export type PreviewDownReason = 'closed' | 'off' | 'expired';

// ── Template variable expansion ──────────────────────────────────────────

interface TemplateVars {
  branch: string;
  issue: number | undefined;
  repo: string;
  pr_number: number | undefined;
  sha: string;
}

function expandTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{branch_slug\}/g, slugify(vars.branch))
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{issue\}/g, String(vars.issue ?? ''))
    .replace(/\{repo\}/g, vars.repo)
    .replace(/\{pr_number\}/g, String(vars.pr_number ?? ''))
    .replace(/\{sha\}/g, vars.sha);
}

function makeEnvVars(vars: TemplateVars): Record<string, string> {
  return {
    FOUNDRY_BRANCH: vars.branch,
    FOUNDRY_BRANCH_SLUG: slugify(vars.branch),
    FOUNDRY_ISSUE: String(vars.issue ?? ''),
    FOUNDRY_REPO: vars.repo,
    FOUNDRY_PR_NUMBER: String(vars.pr_number ?? ''),
    FOUNDRY_SHA: vars.sha,
  };
}

/**
 * What a preview is for. A task's PR and a plain pull request (such as the
 * promotion PR from integration into main) both become one of these; only
 * the task path persists results to local state.
 */
export interface PreviewTarget {
  branch: string;
  sha: string;
  pr_number?: number;
  issue?: number;
  preview_url?: string;
  deployment_id?: number;
  /**
   * Keep this expiry instead of starting a new `ttl_hours` clock. Set when a
   * preview that is already up is redeployed for a new commit: only an
   * explicit request extends a preview's life.
   */
  expires_at?: string;
}

function targetLabel(t: PreviewTarget): string {
  return t.issue !== undefined ? `#${t.issue}` : `PR #${t.pr_number ?? '?'} (${t.branch})`;
}

function targetVars(config: FoundryConfig, t: PreviewTarget): TemplateVars {
  return { branch: t.branch, issue: t.issue, repo: config.repo, pr_number: t.pr_number, sha: t.sha };
}

/** A live preview as its comment records it. */
export interface PreviewRecord {
  url: string;
  /** ISO time; absent when the preview has no expiry. */
  expiresAt?: string;
}

/**
 * The live preview a set of comments records, if Foundry posted one. A
 * torn-down or expired comment carries no `Preview URL:` line and yields
 * nothing.
 */
export function previewRecordFromComments(bodies: string[]): PreviewRecord | undefined {
  for (const body of bodies) {
    if (!body.includes(COMMENT_MARKER)) continue;
    const m = body.match(/Preview URL:\s*(\S+)/);
    if (!m) continue;
    const e = body.match(EXPIRES_RE);
    const expiresAt = e && !Number.isNaN(Date.parse(e[1])) ? e[1] : undefined;
    return { url: m[1], ...(expiresAt ? { expiresAt } : {}) };
  }
  return undefined;
}

/** The preview URL a PR's comment currently advertises, if Foundry posted one. */
export function previewUrlFromComments(bodies: string[]): string | undefined {
  return previewRecordFromComments(bodies)?.url;
}

export async function findPreviewOnPR(repo: string, prNumber: number): Promise<PreviewRecord | undefined> {
  try {
    const comments = await github.getComments(repo, prNumber);
    return previewRecordFromComments(comments.map(c => c.body));
  } catch {
    return undefined;
  }
}

export async function findPreviewUrlOnPR(repo: string, prNumber: number): Promise<string | undefined> {
  return (await findPreviewOnPR(repo, prNumber))?.url;
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
 * The deadline for a provider's up and down commands: `ready_timeout_seconds`,
 * the same budget `verify_preview` gives the preview to come up. An up
 * command that waits for the deployment itself (the Vercel script does)
 * needs the whole budget, not a fixed two minutes.
 */
export function providerCommandTimeoutMs(config: FoundryConfig): number {
  return (config.preview?.ready_timeout_seconds ?? DEFAULT_READY_TIMEOUT_S) * 1000;
}

/**
 * Run the provider's up command. Returns the URL it printed, or null.
 *
 * When `expectUrl` is false the caller has a url_template and only needs the
 * command to run; its output is ignored and no warning is logged about it.
 * This matters because commands like `gh workflow run` print an Actions run
 * URL, which is a URL but not the preview.
 */
async function runProviderCommand(command: string, vars: TemplateVars, expectUrl: boolean, timeoutMs: number): Promise<string | null> {
  const expanded = expandTemplate(command, vars);
  const env = { ...process.env, ...makeEnvVars(vars) };

  const r = await runCommand(expanded, { env, timeoutMs });
  if (!r.success) {
    const tail = r.stderr.trim().slice(-300);
    log.warn(`Provider up command failed (${describeFailure(r, timeoutMs)})${tail ? `: ${tail}` : ''}`);
    return null;
  }
  const output = r.stdout.trim();

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
}

// ── Comment upsert ───────────────────────────────────────────────────────

export interface PreviewCommentOpts {
  url: string;
  state: 'active' | PreviewDownReason;
  sha?: string;
  expiresAt?: string;
  /** How to get the preview back; shown with an expiry and after `off` or an expiry. */
  hint?: string;
}

function utc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** The hint is written to follow "After that:"; standing alone it starts a sentence. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function buildPreviewComment(opts: PreviewCommentOpts): string {
  const { url, state: commentState, sha, expiresAt, hint } = opts;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines: string[] = [COMMENT_MARKER];

  if (commentState === 'active') {
    lines.push('**Preview Environment** — Live', '', `Preview URL: ${url}`);
    if (sha) lines.push(`Commit: \`${sha.slice(0, 7)}\``);
    if (expiresAt) {
      lines.push(`Expires: ${utc(new Date(expiresAt))}.${hint ? ` After that: ${hint}` : ''}`);
      lines.push(`<!-- foundry-preview-expires: ${expiresAt} -->`);
    }
  } else if (commentState === 'expired') {
    lines.push('**Preview Environment** — Expired', '', `~~${url}~~ (expired and torn down)${hint ? `. ${sentence(hint)}` : ''}`);
  } else if (commentState === 'off') {
    lines.push('**Preview Environment** — Torn down', '', `~~${url}~~ (torn down on request)${hint ? `. ${sentence(hint)}` : ''}`);
  } else {
    lines.push('**Preview Environment** — Torn down', '', `~~${url}~~ (inactive)`);
  }

  lines.push('', `_Updated: ${timestamp}_`);
  return lines.join('\n');
}

/** How to ask for this target's preview again. */
export function bringBackHint(config: FoundryConfig, target: PreviewTarget): string {
  const cmd = config.comment_triggers.preview;
  return target.issue !== undefined
    ? `comment \`${cmd}\` on issue #${target.issue} to bring it back.`
    : `run the Foundry workflow with \`issue=${target.pr_number ?? '<PR number>'}\` and \`command=preview\` to bring it back (or comment \`${cmd}\` on this pull request, if the workflow accepts pull request comments).`;
}

async function upsertPreviewComment(
  repo: string,
  prNumber: number,
  opts: PreviewCommentOpts,
): Promise<void> {
  const body = buildPreviewComment(opts);

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
  const result = await previewUpTarget(config, {
    branch: task.branch,
    issue: task.issue,
    pr_number: task.pr_number,
    sha: resolveHeadSha(task.worktree),
  });
  if (!result) return;
  state.updateTaskStatus(config.repo, task.issue, task.status, {
    preview_url: result.url,
    preview_expires_at: result.expiresAt,
    ...(result.deploymentId !== undefined ? { deployment_id: result.deploymentId } : {}),
  });
}

/** Deploy a preview for any target. Returns what was created, or null when no URL could be resolved. */
export async function previewUpTarget(
  config: FoundryConfig,
  target: PreviewTarget,
): Promise<{ url: string; deploymentId?: number; expiresAt?: string } | null> {
  if (!config.preview) return null;
  const vars = targetVars(config, target);
  const label = targetLabel(target);

  // Resolve URL. url_template, when set, is always the preview URL: the
  // provider command still runs (it does the deploy) but its output is not
  // consulted. Only without a template do we read the URL from the command.
  const hasTemplate = Boolean(config.preview.url_template);
  let url: string | null = null;

  if (config.preview.mode === 'provider' && config.preview.up_command) {
    url = await runProviderCommand(config.preview.up_command, vars, !hasTemplate, providerCommandTimeoutMs(config));
  }

  if (hasTemplate) {
    url = resolveTemplateUrl(config, vars);
  }

  if (!url) {
    log.warn(`Preview up: could not resolve URL for ${label}`);
    return null;
  }

  log.info(`Preview URL for ${label}: ${url}`);

  // Create GitHub Deployment (if enabled)
  let deploymentId: number | undefined;
  if (config.github_deployments?.enabled) {
    const deployment = await deployments.createDeployment({
      repo: config.repo,
      ref: target.branch,
      environment: config.github_deployments.environment ?? 'preview',
      description: `Preview for ${label}`,
      transientEnvironment: !(config.github_deployments.production ?? false),
      productionEnvironment: config.github_deployments.production ?? false,
    });

    if (deployment) {
      deploymentId = deployment.id;
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

  // Post/update PR comment. The expiry lives in it: the scheduled reconcile
  // run reads it back to reap the preview.
  const expiresAt = target.expires_at ?? expiryFor(config);
  if (config.preview.comment !== false && target.pr_number) {
    await upsertPreviewComment(config.repo, target.pr_number, {
      url,
      state: 'active',
      sha: target.sha || undefined,
      expiresAt,
      hint: expiresAt ? bringBackHint(config, target) : undefined,
    });
  }

  return { url, deploymentId, expiresAt };
}

export async function previewDown(config: FoundryConfig, task: TaskState, reason: PreviewDownReason = 'closed'): Promise<boolean> {
  if (!config.preview) return true;
  if (!task.preview_url) return true;
  return previewDownTarget(config, {
    branch: task.branch,
    issue: task.issue,
    // After a merge the PR is closed and pr_number is gone; the preview
    // comment still names its PR.
    pr_number: task.pr_number ?? task.preview_pr_number,
    sha: resolveHeadSha(task.worktree),
    preview_url: task.preview_url,
    deployment_id: task.deployment_id,
  }, reason);
}

/**
 * Tear down a preview for any target. `preview_url` must be set. Returns
 * false when the provider's down command failed. An expired preview whose
 * down command failed keeps its comment as it is, so the next reconcile run
 * tries again instead of recording as gone something that is still running.
 */
export async function previewDownTarget(config: FoundryConfig, target: PreviewTarget, reason: PreviewDownReason = 'closed'): Promise<boolean> {
  if (!config.preview || !target.preview_url) return true;
  const vars = targetVars(config, target);
  const label = targetLabel(target);
  let downOk = true;

  // Run down command (provider mode only)
  if (config.preview.mode === 'provider' && config.preview.down_command) {
    const expanded = expandTemplate(config.preview.down_command, vars);
    const env = { ...process.env, ...makeEnvVars(vars) };
    const timeoutMs = providerCommandTimeoutMs(config);
    const r = await runCommand(expanded, { env, timeoutMs });
    if (!r.success) {
      downOk = false;
      log.warn(`Preview down command failed for ${label} (${describeFailure(r, timeoutMs)}): ${r.stderr.trim().slice(-300)}`);
    }
  }
  if (!downOk && reason === 'expired') return false;

  // Set deployment status to inactive
  if (config.github_deployments?.enabled && target.deployment_id) {
    await deployments.createDeploymentStatus({
      repo: config.repo,
      deploymentId: target.deployment_id,
      state: 'inactive',
      description: 'Preview torn down',
      autoInactive: config.github_deployments.auto_inactive ?? true,
    });
  }

  // Update PR comment
  if (config.preview.comment !== false && target.pr_number) {
    await upsertPreviewComment(config.repo, target.pr_number, {
      url: target.preview_url,
      state: reason,
      hint: reason === 'closed' ? undefined : bringBackHint(config, target),
    });
  }

  log.info(`Preview torn down for ${label}${reason === 'closed' ? '' : ` (${reason})`}`);
  return downOk;
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
