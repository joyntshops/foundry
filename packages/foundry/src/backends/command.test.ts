import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createCommandBackend, escapeForDoubleQuotes, CLAUDE_CODE_PRESET } from './command.js';
import type { AgentLaunchParams } from '../types.js';

const params = (over: Partial<AgentLaunchParams> = {}): AgentLaunchParams => ({
  worktree: '/w', issue_url: 'https://github.com/o/r/issues/7', issue_number: 7, repo: 'o/r',
  title: 'Add login', body: 'Body', labels: [], log_dir: '/logs', state_dir: '/state', ...over,
});

describe('escapeForDoubleQuotes', () => {
  it('neutralises every character that is live inside double quotes', () => {
    expect(escapeForDoubleQuotes('a"b$c`d\\e')).toBe('a\\"b\\$c\\`d\\\\e');
  });
});

describe('command backend', () => {
  it('a hostile issue title cannot execute through {title}', () => {
    const backend = createCommandBackend('t', { type: 'command', command: 'printf "%s" "{title}"' });
    const hostile = 'x"; echo INJECTED; echo "$(echo SUBSHELL) `echo BACKTICK`';
    const out = execFileSync('bash', ['-c', backend.resolveCommand(params({ title: hostile }))], { encoding: 'utf-8' });
    expect(out).toBe(hostile);
  });

  it('does not treat $& or $1 in a value as a replacement pattern', () => {
    const backend = createCommandBackend('t', { type: 'command', command: 'echo {worktree}' });
    expect(backend.resolveCommand(params({ worktree: '/w/$&/$1' }))).toBe('echo /w/$&/$1');
  });

  it('leaves unknown placeholders alone', () => {
    const backend = createCommandBackend('t', { type: 'command', command: 'echo {nope} {issue_number}' });
    expect(backend.resolveCommand(params())).toBe('echo {nope} 7');
  });

  it('always provides the issue through the environment, unescaped', () => {
    const backend = createCommandBackend('t', { type: 'command', command: 'x', env: { MINE: '{log_dir}/out' } });
    const env = backend.resolveEnv(params({ title: 'a "quoted" $title' }));
    expect(env.FOUNDRY_ISSUE_TITLE).toBe('a "quoted" $title');
    expect(env.FOUNDRY_ISSUE_NUMBER).toBe('7');
    expect(env.FOUNDRY_ISSUE_URL).toBe('https://github.com/o/r/issues/7');
    expect(env.MINE).toBe('/logs/out');
  });

  it('the Claude preset takes the title from the environment and asks for a report', () => {
    const cmd = createCommandBackend('claude-code', CLAUDE_CODE_PRESET).resolveCommand(params({ title: '$(evil)' }));
    expect(cmd).not.toContain('evil');
    expect(cmd).toContain('$FOUNDRY_ISSUE_TITLE');
    expect(cmd).toContain('--json-schema "$FOUNDRY_REPORT_SCHEMA"');
    expect(cmd).toContain('--disallowedTools AskUserQuestion');
    expect(cmd).toContain('< /dev/null');
  });
});

import { resolveBackend } from './index.js';
import { DEFAULTS } from '../config.js';

describe('resolveBackend presets', () => {
  const cfg = (def: any) => ({ ...DEFAULTS, repo: 'o/r', default_agent_backend: 'a', agent_backends: { a: def } });

  it('preset: claude-code uses the maintained command', () => {
    const cmd = resolveBackend(cfg({ type: 'command', preset: 'claude-code' })).resolveCommand(params());
    expect(cmd).toContain('--json-schema "$FOUNDRY_REPORT_SCHEMA"');
  });
  it('an explicit command overrides the preset', () => {
    expect(resolveBackend(cfg({ type: 'command', preset: 'claude-code', command: 'echo hi' })).resolveCommand(params())).toBe('echo hi');
  });
  it('rejects a backend with neither', () => {
    expect(() => resolveBackend(cfg({ type: 'command' }))).toThrow(/needs a `command` or `preset/);
  });
  it('rejects an unknown preset', () => {
    expect(() => resolveBackend(cfg({ type: 'command', preset: 'gpt' }))).toThrow(/unknown preset/);
  });
});
