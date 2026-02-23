/**
 * Command agent backend — runs an arbitrary configured command.
 * Template variables: {worktree}, {issue_url}, {issue_number}, {repo}, {title}, {log_dir}, {state_dir}
 */
import type { AgentBackend, AgentBackendDef, AgentLaunchParams, ResumeParams } from '../types.js';

function interpolate(template: string, params: AgentLaunchParams): string {
  return template
    .replace(/\{worktree\}/g, params.worktree)
    .replace(/\{issue_url\}/g, params.issue_url)
    .replace(/\{issue_number\}/g, String(params.issue_number))
    .replace(/\{repo\}/g, params.repo)
    .replace(/\{title\}/g, params.title)
    .replace(/\{body\}/g, (params.body ?? '').slice(0, 4000))
    .replace(/\{log_dir\}/g, params.log_dir)
    .replace(/\{state_dir\}/g, params.state_dir);
}

function interpolateResume(template: string, params: ResumeParams): string {
  // First apply all standard AgentLaunchParams placeholders
  let result = interpolate(template, params);
  // Then apply resume-specific placeholders
  result = result
    .replace(/\{session_id\}/g, params.session_id)
    .replace(/\{prompt\}/g, params.prompt);
  return result;
}

export function createCommandBackend(name: string, def: AgentBackendDef): AgentBackend {
  return {
    name,
    resolveCommand(params: AgentLaunchParams): string {
      return interpolate(def.command, params);
    },
    resolveResumeCommand(params: ResumeParams): string | null {
      if (!def.resume_command) return null;
      return interpolateResume(def.resume_command, params);
    },
    resolveEnv(params: AgentLaunchParams): Record<string, string> {
      const env: Record<string, string> = {};
      if (def.env) {
        for (const [k, v] of Object.entries(def.env)) {
          env[k] = interpolate(v, params);
        }
      }
      return env;
    },
  };
}

/**
 * Claude Code preset — a pre-configured command backend.
 */
export const CLAUDE_CODE_PRESET: AgentBackendDef = {
  type: 'command',
  command: 'claude --dangerously-skip-permissions -p "You are working on issue #{issue_number}: {title}. The issue is at {issue_url}. Read the issue body and implement the task. When done, create a commit with your changes." --verbose --output-format stream-json 2>&1 | tee {log_dir}/agent.log',
  resume_command: 'claude --dangerously-skip-permissions -p "{prompt}" --resume "{session_id}" --verbose --output-format stream-json 2>&1 | tee {log_dir}/agent.log',
  env: {},
};
