/**
 * Verification pipeline — lint, typecheck, build, unit tests.
 *
 * Every step runs asynchronously (see run-command.ts): a verify step can
 * take minutes, and blocking the event loop that long leaves the GitHub
 * client's keep-alive socket dead for the call that publishes the result.
 */
import { runCommand, describeFailure } from './run-command.js';
import type { FoundryConfig } from '../types.js';

/** Name of the check run that carries a verify result; the one a branch rule requires. */
export const VERIFY_CHECK_NAME = 'Foundry Verification';

/** Per step. */
export const VERIFY_STEP_TIMEOUT_MS = 300_000;

export interface VerifyResult {
  command: string;
  success: boolean;
  output: string;
  duration_ms: number;
}

export async function runVerifyStep(
  command: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs: number = VERIFY_STEP_TIMEOUT_MS,
): Promise<VerifyResult> {
  const r = await runCommand(command, {
    cwd,
    timeoutMs,
    env: { ...process.env, CI: '1', ...extraEnv },
  });
  if (r.success) {
    return { command, success: true, output: r.stdout.slice(-5000), duration_ms: r.duration_ms };
  }
  const combined = (r.stdout + '\n' + r.stderr).trim();
  const why = r.status === 0 || r.timedOut || r.signal ? `\n[${describeFailure(r, timeoutMs)}]` : '';
  return {
    command,
    success: false,
    output: (combined + why).slice(-5000),
    duration_ms: r.duration_ms,
  };
}

export async function runVerifyPipeline(config: FoundryConfig, cwd: string): Promise<{
  passed: boolean;
  results: VerifyResult[];
}> {
  const results: VerifyResult[] = [];
  let passed = true;

  for (const cmd of config.verify) {
    const result = await runVerifyStep(cmd, cwd);
    results.push(result);
    if (!result.success) {
      passed = false;
      break; // fail-fast
    }
  }

  return { passed, results };
}

export async function runIntegrationRebuild(config: FoundryConfig, cwd: string): Promise<VerifyResult | null> {
  if (!config.integration_rebuild) return null;
  return runVerifyStep(config.integration_rebuild, cwd);
}

export interface VerifyAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
}

/**
 * Parse verification output for file:line error patterns.
 * Matches common formats:
 *   - ESLint/TSC: src/foo.ts(10,5): error TS1234: msg  or  src/foo.ts:10:5: msg
 *   - Generic:    path/file.ext:line: message
 * Returns up to 50 annotations (GitHub API limit per request).
 */
export function parseAnnotations(results: VerifyResult[]): VerifyAnnotation[] {
  const annotations: VerifyAnnotation[] = [];
  // Match patterns like: path.ext:line:col: message  or  path.ext(line,col): message
  const linePattern = /^([^\s:()]+\.\w+)[:(](\d+)[,:]?\d*\)?[:\s]+(.+)$/;

  for (const result of results) {
    if (result.success) continue;
    for (const line of result.output.split('\n')) {
      const match = line.trim().match(linePattern);
      if (match) {
        const [, filePath, lineNum, message] = match;
        annotations.push({
          path: filePath,
          start_line: Number(lineNum),
          end_line: Number(lineNum),
          annotation_level: 'failure',
          message: message.trim(),
        });
        if (annotations.length >= 50) return annotations;
      }
    }
  }

  return annotations;
}
