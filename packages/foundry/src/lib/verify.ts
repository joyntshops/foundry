/**
 * Verification pipeline — lint, typecheck, build, unit tests.
 */
import { execSync } from 'node:child_process';
import type { FoundryConfig } from '../types.js';

export interface VerifyResult {
  command: string;
  success: boolean;
  output: string;
  duration_ms: number;
}

export function runVerifyStep(command: string, cwd: string): VerifyResult {
  const start = Date.now();
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: 300_000, // 5 min per step
      env: { ...process.env, CI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      command,
      success: true,
      output: output.slice(-5000), // keep tail
      duration_ms: Date.now() - start,
    };
  } catch (err: any) {
    return {
      command,
      success: false,
      output: (err.stdout ?? '' + '\n' + (err.stderr ?? '')).slice(-5000),
      duration_ms: Date.now() - start,
    };
  }
}

export function runVerifyPipeline(config: FoundryConfig, cwd: string): {
  passed: boolean;
  results: VerifyResult[];
} {
  const results: VerifyResult[] = [];
  let passed = true;

  for (const cmd of config.verify) {
    const result = runVerifyStep(cmd, cwd);
    results.push(result);
    if (!result.success) {
      passed = false;
      break; // fail-fast
    }
  }

  return { passed, results };
}

export function runIntegrationRebuild(config: FoundryConfig, cwd: string): VerifyResult | null {
  if (!config.integration_rebuild) return null;
  return runVerifyStep(config.integration_rebuild, cwd);
}
