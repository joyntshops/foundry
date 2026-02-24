/**
 * Joynt Foundry — Core type definitions
 */

// ── Configuration (.joynt-foundry.yml) ──────────────────────────────────

export interface AgentBackendDef {
  type: 'command';
  command: string;
  resume_command?: string;   // template with {session_id}, {prompt}, {log_dir}
  env?: Record<string, string>;
}

export interface FoundryConfig {
  repo: string;                         // e.g. "joyntshops/foundry"

  labels: {
    ready: string;                      // default "state:ready"
    in_progress: string;                // default "state:in-progress"
    done: string;                       // default "state:done"
    ready_for_review: string;           // default "state:ready-for-human-review"
    waiting_for_input: string;          // default "state:waiting-for-input"
    failed: string;                     // default "state:failed"
    plan_review: string;                // default "state:plan-review"
  };

  mode_labels?: {
    plan: string;                       // default "mode:plan"
    auto: string;                       // default "mode:auto"
    default: string;                    // default "mode:default"
  };

  branch_template: string;              // default "feature/{issue}-{slug}"
  worktree_base: string;                // default "../wts"
  tmux_template: string;               // default "foundry-{issue}"

  max_sessions: number;                 // default 4
  max_verify_parallel: number;          // default 1
  max_input_rounds: number;             // default 3

  verify: string[];                     // e.g. ["npm run lint", "npm run build", "npm test"]
  integration_rebuild: string;          // e.g. "npm run build"

  comment_triggers: {
    replan: string;                     // default "@foundry replan"
    restart: string;                    // default "@foundry restart"
  };

  version_sources: string[];            // ordered list of version file paths (package.json, Cargo.toml, pyproject.toml)
  tag_prefix: string;                   // default "v"

  default_agent_backend: string;        // default "command"
  agent_backends: Record<string, AgentBackendDef>;

  agent_label_map?: Record<string, string>;   // label → backend name
  poll_interval_seconds: number;              // default 30
  github_backend: 'gh-cli' | 'octokit';      // default "gh-cli"
}

// ── Local State (~/.joynt-foundry/) ─────────────────────────────────────

export type TaskStatus =
  | 'claimed'
  | 'agent-running'
  | 'verifying'
  | 'pr-open'
  | 'reviewing'
  | 'waiting-for-input'
  | 'resuming'
  | 'pr-changes-requested'
  | 'plan-review'
  | 'done'
  | 'failed'
  | 'stopped';

export interface TaskState {
  issue: number;
  title: string;
  repo: string;
  branch: string;
  worktree: string;
  tmux_session: string;
  pr_url?: string;
  pr_number?: number;
  agent_backend: string;
  agent_command: string;
  status: TaskStatus;
  claimed_at: string;
  updated_at: string;
  runner_id: string;
  session_id?: string;
  input_request_count?: number;
  last_agent_message?: string;
}

export interface RunnerState {
  runner_id: string;
  repo: string;
  tasks: Record<number, TaskState>;     // keyed by issue number
}

// ── Agent Backend Interface ─────────────────────────────────────────────

export interface AgentLaunchParams {
  worktree: string;
  issue_url: string;
  issue_number: number;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  log_dir: string;
  state_dir: string;
  permission_mode: string;
}

export interface ResumeParams extends AgentLaunchParams {
  session_id: string;
  prompt: string;
}

export interface AgentBackend {
  name: string;
  resolveCommand(params: AgentLaunchParams): string;
  resolveResumeCommand(params: ResumeParams): string | null;
  resolveEnv(params: AgentLaunchParams): Record<string, string>;
}

// ── GitHub Types ────────────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  html_url: string;
  state: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

// ── Agent Outcome ────────────────────────────────────────────────────────

export type AgentOutcomeType = 'completed' | 'needs-input' | 'errored' | 'indeterminate' | 'plan-completed';

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestionData {
  question: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

export interface AgentOutcome {
  type: AgentOutcomeType;
  session_id: string | null;
  final_message: string | null;
  ask_user_questions: AskUserQuestionData[] | null;
}
