import { describe, it, expect } from 'vitest';
import { runVerifyStep } from './verify.js';

describe('runVerifyStep', () => {
  it('keeps both stdout and stderr of a failed command', () => {
    const r = runVerifyStep("sh -c 'echo on-stdout; echo on-stderr >&2; exit 3'", process.cwd());
    expect(r.success).toBe(false);
    expect(r.output).toContain('on-stdout');
    expect(r.output).toContain('on-stderr');
  });

  it('keeps stderr when stdout is empty', () => {
    // The precedence bug this guards against returned '' here: `a ?? '' + b` is `a ?? ('' + b)`.
    const r = runVerifyStep("sh -c 'echo only-stderr >&2; exit 1'", process.cwd());
    expect(r.output).toContain('only-stderr');
  });

  it('passes an environment prefix through the shell', () => {
    const r = runVerifyStep("FOO=bar sh -c 'echo $FOO'", process.cwd());
    expect(r.success).toBe(true);
    expect(r.output).toContain('bar');
  });
});
