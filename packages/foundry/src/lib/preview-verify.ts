/**
 * Preview verification — commands run against a live preview URL.
 *
 * `verify` proves the branch builds and its unit tests pass. `verify_preview`
 * proves the deployed thing works: it runs after the preview is up, with
 * FOUNDRY_PREVIEW_URL in the environment, and gates
 * `state:ready-for-human-review`. This is where end-to-end and integration
 * tests live once there is no shared test environment to run them in.
 *
 * A preview can take a while to become reachable (a static-site build, a
 * container rollout), so the pipeline first waits for the URL to answer.
 */
import { runVerifyStep, type VerifyResult } from './verify.js';
import * as log from './log.js';
import type { FoundryConfig } from '../types.js';

export interface PreviewVerifyInput {
  url: string;
  /** Directory the commands run in: the branch's worktree. */
  cwd: string;
  /** Extra environment, e.g. FOUNDRY_PR_NUMBER. FOUNDRY_PREVIEW_URL is always set. */
  env?: Record<string, string>;
}

export interface PreviewVerifyOutcome {
  passed: boolean;
  url: string;
  results: VerifyResult[];
}

const DEFAULT_READY_TIMEOUT_S = 300;
const READY_POLL_MS = 5_000;

/** Poll until the URL answers with a non-5xx status, or the timeout passes. */
export async function waitForUrl(
  url: string,
  timeoutMs: number,
  pollMs: number = READY_POLL_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ready: boolean; status?: number; attempts: number }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let status: number | undefined;
  while (true) {
    attempts++;
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
      status = res.status;
      if (res.status < 500 && res.status !== 404) return { ready: true, status, attempts };
    } catch {
      status = undefined;
    }
    if (Date.now() >= deadline) return { ready: false, status, attempts };
    await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

export function isConfigured(config: FoundryConfig): boolean {
  return (config.verify_preview ?? []).length > 0;
}

/**
 * Wait for the preview, then run every `verify_preview` command fail-fast.
 * Never throws; a preview that never comes up is reported as a failed step.
 */
export async function verifyPreview(config: FoundryConfig, input: PreviewVerifyInput): Promise<PreviewVerifyOutcome> {
  const commands = config.verify_preview ?? [];
  const results: VerifyResult[] = [];
  const timeoutS = config.preview?.ready_timeout_seconds ?? DEFAULT_READY_TIMEOUT_S;

  const start = Date.now();
  const ready = await waitForUrl(input.url, timeoutS * 1000);
  if (!ready.ready) {
    results.push({
      command: `wait for ${input.url}`,
      success: false,
      output: `Preview did not answer within ${timeoutS}s (${ready.attempts} attempts, last status ${ready.status ?? 'no response'}).`,
      duration_ms: Date.now() - start,
    });
    return { passed: false, url: input.url, results };
  }
  log.info(`Preview is up (${ready.status}) after ${ready.attempts} attempt${ready.attempts === 1 ? '' : 's'}.`);

  const env = { ...(input.env ?? {}), FOUNDRY_PREVIEW_URL: input.url };
  for (const cmd of commands) {
    const r = runVerifyStep(cmd, input.cwd, env);
    results.push(r);
    if (!r.success) return { passed: false, url: input.url, results };
  }
  return { passed: true, url: input.url, results };
}

/** Markdown summary for a status comment or PR comment. */
export function formatPreviewVerify(outcome: PreviewVerifyOutcome): string {
  const lines = [
    `**Preview verification ${outcome.passed ? 'passed' : 'FAILED'}** against ${outcome.url}`,
    '',
    ...outcome.results.map(r => `- \`${r.command}\`: ${r.success ? 'passed' : 'FAILED'} (${r.duration_ms}ms)`),
  ];
  const failed = outcome.results.filter(r => !r.success);
  if (failed.length > 0) {
    lines.push('', ...failed.map(r => `\`\`\`\n${r.output.slice(-1000)}\n\`\`\``));
  }
  return lines.join('\n');
}
