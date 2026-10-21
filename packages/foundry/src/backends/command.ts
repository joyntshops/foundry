/**
 * Command agent backend — runs an arbitrary configured command.
 *
 * Template variables: {worktree}, {issue_url}, {issue_number}, {repo}, {title},
 * {body}, {log_dir}, {state_dir}, {permission_mode}.
 *
 * {title} and {body} are written by whoever opened the issue and end up in a
 * shell command line, so they are escaped for use INSIDE DOUBLE QUOTES. Put
 * them nowhere else. Better, do not interpolate them at all: every launch also
 * gets FOUNDRY_ISSUE_TITLE, FOUNDRY_ISSUE_BODY, FOUNDRY_ISSUE_NUMBER and
 * FOUNDRY_ISSUE_URL in its environment, and "$FOUNDRY_ISSUE_TITLE" is never
 * re-evaluated by the shell.
 */
import type { AgentBackend, AgentBackendDef, AgentLaunchParams } from '../types.js';

/** Escape untrusted text for a bash double-quoted string: \\ " $ and ` lose their meaning. */
export function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\"$`]/g, c => '\\' + c);
}

function interpolate(template: string, params: AgentLaunchParams, escapeUntrusted: boolean): string {
  const untrusted = (v: string) => (escapeUntrusted ? escapeForDoubleQuotes(v) : v);
  const vars: Record<string, string> = {
    worktree: params.worktree,
    issue_url: params.issue_url,
    issue_number: String(params.issue_number),
    repo: params.repo,
    title: untrusted(params.title),
    body: untrusted((params.body ?? '').slice(0, 4000)),
    log_dir: params.log_dir,
    state_dir: params.state_dir,
    permission_mode: params.permission_mode ?? '--dangerously-skip-permissions',
  };
  // Function replacer: a `$&` or `$1` inside a value must not be read as a replacement pattern.
  return template.replace(/\{([a-z_]+)\}/g, (match, name: string) => (name in vars ? vars[name] : match));
}

export function createCommandBackend(name: string, def: AgentBackendDef & { command: string }): AgentBackend {
  return {
    name,
    resolveCommand(params: AgentLaunchParams): string {
      return interpolate(def.command, params, true);
    },
    resolveEnv(params: AgentLaunchParams): Record<string, string> {
      // Environment values are handed to the process directly, never parsed by a shell.
      const env: Record<string, string> = {
        FOUNDRY_AGENT_BRIEF: AGENT_BRIEF,
        FOUNDRY_RESUME_CONTEXT: '',
        FOUNDRY_ISSUE_NUMBER: String(params.issue_number),
        FOUNDRY_ISSUE_URL: params.issue_url,
        FOUNDRY_ISSUE_TITLE: params.title,
        FOUNDRY_ISSUE_BODY: params.body ?? '',
      };
      if (def.env) {
        for (const [k, v] of Object.entries(def.env)) {
          env[k] = interpolate(v, params, false);
        }
      }
      return env;
    },
  };
}

/**
 * Claude Code preset — a pre-configured command backend.
 *
 * `--json-schema "$FOUNDRY_REPORT_SCHEMA"` makes Claude Code end the run with a
 * schema-validated report (see lib/agent-report.ts). AskUserQuestion is
 * disallowed because nobody is there to answer it; questions go in the report.
 * `< /dev/null` stops the CLI waiting three seconds for stdin.
 */
/**
 * The developer brief, appended to the agent's system prompt by the preset.
 * This is the standing instruction a stakeholder would give a developer; the
 * per-issue brief is the issue itself.
 */
export const AGENT_BRIEF = [
  'You are the developer assigned to this GitHub issue. The person who wrote it is a stakeholder, not a programmer, and will review your work as a pull request.',
  'Read the issue and every comment on it before changing anything.',
  'Make reasonable implementation decisions yourself and list each one under `assumptions` in your report. Ask a question only when the answer materially changes the work, and offer concrete options.',
  'Change only what the issue needs. Follow the conventions already in the repository.',
  'Commit as you go with clear messages. Never push, open pull requests, or change labels; Foundry does that.',
  'If `.joynt-foundry.yml` lists verify commands, run them before reporting done and fix what they find.',
  'End by reporting your outcome truthfully with the required schema: done, needs_input, plan_ready, or blocked.',
].join(' ');

export const CLAUDE_CODE_PRESET: AgentBackendDef & { command: string } = {
  type: 'command',
  command: 'claude {permission_mode} -p "You are working on issue #{issue_number}: $FOUNDRY_ISSUE_TITLE. The issue is at {issue_url}. $FOUNDRY_RESUME_CONTEXT" --append-system-prompt "$FOUNDRY_AGENT_BRIEF" --json-schema "$FOUNDRY_REPORT_SCHEMA" --disallowedTools AskUserQuestion --verbose --output-format stream-json < /dev/null 2>&1 | tee {log_dir}/agent.log',
  env: {},
};
