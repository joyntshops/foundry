/**
 * Joynt Foundry — Core type definitions
 */

// ── Configuration (.joynt-foundry.yml) ──────────────────────────────────

export interface AgentBackendDef {
  type: 'command';
  /** Use a command Foundry maintains instead of copying one into config, where it would drift. */
  preset?: 'claude-code';
  /** Required unless `preset` is set. Overrides the preset's command when both are given. */
  command?: string;
  env?: Record<string, string>;
}

export interface FoundryConfig {
  repo: string;                         // e.g. "joyntshops/foundry"

  /**
   * State labels. Foundry owns them: exactly one is on a tracked issue at a
   * time and only Foundry adds or removes them. Humans never set a state
   * label to make something happen; they comment a command.
   */
  labels: {
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

  /**
   * The repo's long-lived branches, by name. Feature branches are cut from
   * and merged into `integration`; `production` is what it is promoted to.
   * Never assumed: onboarding must not require renaming a branch that
   * deploy tooling already keys on.
   */
  branches: {
    integration: string;                // default "integration"
    production: string;                 // default "main"
  };

  branch_template: string;              // default "feature/{issue}-{slug}"
  worktree_base: string;                // default "../wts"

  max_input_rounds: number;             // default 3
  /** Passed to the agent as FOUNDRY_MAX_TURNS; the preset uses --max-turns. Default 150. */
  agent_max_turns?: number;
  /** An in-progress issue with no status update for this long is marked failed by `foundry reconcile`. Default 120. */
  reconcile_stale_minutes?: number;

  verify: string[];                     // e.g. ["npm run lint", "npm run build", "npm test"]
  /** Run against the live preview (FOUNDRY_PREVIEW_URL) before ready-for-review. Default []. */
  verify_preview?: string[];
  integration_rebuild: string;          // e.g. "npm run build"

  /**
   * The commands, the only comments that make Foundry act. `go`, `restart`
   * and `stop` start or stop the agent; `preview` deploys the open PR's
   * preview and `<preview> off` tears it down. Every other comment is
   * context: it reaches the agent through the issue file on the next
   * launch, and never starts a job.
   */
  comment_triggers: {
    go: string;                         // default "@foundry go"
    restart: string;                    // default "@foundry restart"
    stop: string;                       // default "@foundry stop"
    preview: string;                    // default "@foundry preview"; followed by " off" to tear down
  };

  version_sources: string[];            // ordered list of version file paths (package.json, Cargo.toml, pyproject.toml)
  tag_prefix: string;                   // default "v"

  default_agent_backend: string;        // default "command"
  agent_backends: Record<string, AgentBackendDef>;

  agent_label_map?: Record<string, string>;   // label → backend name
  github_backend: 'gh-cli' | 'octokit';      // default "gh-cli"


  preview?: {
    mode: 'template' | 'provider';
    url_template?: string;
    up_command?: string;
    down_command?: string;
    comment?: boolean;
    /**
     * When a preview is deployed. `auto` (default): when the PR opens and
     * after every agent round, and `verify_preview` gates ready-for-review.
     * `on_demand`: only when someone with write access asks with the
     * `preview` command; a task is ready for review on `verify` alone. For
     * previews that cost money while they are up.
     */
    trigger?: 'auto' | 'on_demand';
    /**
     * Tear a preview down this many hours after it was deployed. The
     * scheduled reconcile run does it, so the real lifetime is rounded up to
     * the workflow's `schedule:` interval. Unset: previews live until the PR
     * closes.
     */
    ttl_hours?: number;
    /**
     * Also preview any pull request whose base branch is listed here, task or
     * not: up on open/reopen, redeploy on push, down on close. For the
     * promotion PR from `integration` into `main`.
     */
    pull_request_bases?: string[];
    /**
     * How long to wait for the preview URL to answer before verify_preview
     * runs, and the deadline for up_command and down_command. Default 300.
     */
    ready_timeout_seconds?: number;
    /**
     * Text the preview's body must contain before it counts as up, with
     * {sha}, {branch}, {pr_number} expanded. Without it a redeploy is
     * verified against the previous version still being served.
     */
    ready_match?: string;
  };

  review?: {
    /** On an approving review: rebase onto the base, wait for checks, merge (rebase method). Default true. */
    merge_on_approval?: boolean;
    /** How long to wait for the PR's checks before giving up. Default 900. */
    checks_timeout_seconds?: number;
  };

  github_deployments?: {
    enabled: boolean;
    environment?: string;
    production?: boolean;
    auto_inactive?: boolean;
  };
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
  tmux_session: string;                 // worker id (`foundry-<issue>`); name kept for claim-comment compatibility
  pr_url?: string;
  pr_number?: number;
  agent_backend: string;
  agent_command?: string;
  status: TaskStatus;
  claimed_at: string;
  updated_at: string;
  runner_id: string;
  session_id?: string;
  permission_mode?: string;
  input_request_count?: number;
  last_agent_message?: string;
  /** Usage of the most recent agent run, from the transcript's result event. */
  last_run?: { cost_usd?: number; turns?: number; duration_ms?: number };
  /** The issue body at claim time; written to FOUNDRY_ISSUE_FILE on every launch. */
  issue_body?: string;
  /**
   * The branch head when the agent was relaunched in this job. A round that
   * ends on the same commit added nothing, and the PR description is left
   * alone. In-job only: launch and completion are one job.
   */
  round_start_sha?: string;
  preview_url?: string;
  /** ISO time after which the preview is reaped (preview.ttl_hours); read back from the preview comment. */
  preview_expires_at?: string;
  deployment_id?: number;
  /**
   * The PR whose comment records the preview. Kept apart from pr_number
   * because it outlives the PR: on pull_request.closed the PR is already
   * merged when the preview has to come down.
   */
  preview_pr_number?: number;
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

export interface AgentBackend {
  name: string;
  resolveCommand(params: AgentLaunchParams): string;
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

export type AgentOutcomeType = 'completed' | 'needs-input' | 'plan-completed' | 'blocked' | 'errored';

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
  /** Text to show a human: the report summary, the plan, or a failure explanation. Never branched on. */
  final_message: string | null;
  ask_user_questions: AskUserQuestionData[] | null;
  /** The agent's typed report, when it submitted a valid one. */
  report?: import('./lib/agent-report.js').AgentReport | null;
  /** Why the task failed or is blocked, for `errored` and `blocked`. */
  reason?: string;
  /** From the result event when present. */
  usage?: { cost_usd?: number; turns?: number; duration_ms?: number };
}
