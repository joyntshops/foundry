import { describe, it, expect } from 'vitest';
import { runVerifyStep, runVerifyPipeline } from './verify.js';
import { DEFAULTS } from '../config.js';

describe('runVerifyStep', () => {
  it('keeps both stdout and stderr of a failed command', async () => {
    const r = await runVerifyStep("sh -c 'echo on-stdout; echo on-stderr >&2; exit 3'", process.cwd());
    expect(r.success).toBe(false);
    expect(r.output).toContain('on-stdout');
    expect(r.output).toContain('on-stderr');
  });

  it('keeps stderr when stdout is empty', async () => {
    // The precedence bug this guards against returned '' here: `a ?? '' + b` is `a ?? ('' + b)`.
    const r = await runVerifyStep("sh -c 'echo only-stderr >&2; exit 1'", process.cwd());
    expect(r.output).toContain('only-stderr');
  });

  it('passes an environment prefix through the shell', async () => {
    const r = await runVerifyStep("FOO=bar sh -c 'echo $FOO'", process.cwd());
    expect(r.success).toBe(true);
    expect(r.output).toContain('bar');
  });

  it('fails a step that outlives its timeout and says so in the output', async () => {
    const r = await runVerifyStep('echo started; sleep 30', process.cwd(), {}, 200);
    expect(r.success).toBe(false);
    expect(r.output).toContain('started');
    expect(r.output).toContain('timed out after 0s');
  });
});

describe('runVerifyPipeline', () => {
  it('runs the steps in order and stops at the first failure', async () => {
    const r = await runVerifyPipeline({ ...DEFAULTS, repo: 'o/r', verify: ['echo one', 'false', 'echo never'] }, process.cwd());
    expect(r.passed).toBe(false);
    expect(r.results.map(x => x.command)).toEqual(['echo one', 'false']);
  });
});
