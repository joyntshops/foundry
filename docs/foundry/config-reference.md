# Configuration Reference

Foundry is configured via `.joynt-foundry.yml` at the repo root.

## Full Schema

```yaml
# ── Required ─────────────────────────────────────────────────────────

repo: "org/repo"                        # GitHub owner/repo

# ── Labels ───────────────────────────────────────────────────────────

labels:
  ready: "state:ready"                  # Task eligible for claiming
  in_progress: "state:in-progress"      # Task claimed by a runner
  done: "state:done"                    # Task completed
  ready_for_review: "state:ready-for-human-review"  # Awaiting human review
  spec_changed: "spec:changed"          # Spec changed, replan needed

# ── Branching & Worktrees ────────────────────────────────────────────

branch_template: "feature/{issue}-{slug}"   # {issue} = number, {slug} = slugified title
worktree_base: "./wts"                      # Relative to repo root or absolute
tmux_template: "foundry-{issue}"            # {issue} = number

# ── Concurrency ──────────────────────────────────────────────────────

max_sessions: 4                         # Max concurrent agent sessions
max_verify_parallel: 1                  # Max concurrent verification pipelines

# ── Verification ─────────────────────────────────────────────────────

verify:                                 # Commands run before PR creation
  - "npm run lint"
  - "npm run typecheck"
  - "npm run build"
  - "npm test"

integration_rebuild: "npm run build"    # Command run after integration merge

# ── Comment Triggers ─────────────────────────────────────────────────

comment_triggers:
  replan: "@foundry replan"             # Trigger replan on comment match
  restart: "@foundry restart"           # Trigger restart on comment match

# ── Versioning ───────────────────────────────────────────────────────

version_sources:                        # Ordered list of package.json paths
  - "package.json"                      # First = primary (version read from here)
  - "packages/api/package.json"
  - "packages/web/package.json"

tag_prefix: "v"                         # Release tag prefix (e.g. v1.2.3)

# ── Polling ──────────────────────────────────────────────────────────

poll_interval_seconds: 30               # Seconds between issue polls

# ── Agent Backends ───────────────────────────────────────────────────

default_agent_backend: "claude-code"    # Backend used when no label match

agent_backends:
  claude-code:
    type: command
    command: >-
      claude --dangerously-skip-permissions
      -p "Implement issue #{issue_number}: {title}. See {issue_url}"
      2>&1 | tee {log_dir}/agent.log

  command:
    type: command
    command: "echo 'Configure your agent command'"

# ── Label → Backend Mapping (optional) ───────────────────────────────

agent_label_map:
  "agent:claude": "claude-code"
  "agent:cursor": "cursor"
```

## Field Reference

### `repo` (required)
GitHub repository in `owner/repo` format.

### `labels`
Label names used by Foundry to track task state. Customize if your repo uses different label conventions.

### `branch_template`
Template for feature branch names. Variables: `{issue}` (number), `{slug}` (slugified title, max 40 chars).

### `worktree_base`
Base directory for git worktrees. Resolved relative to the repo root. Default: `./wts` (inside the repo, gitignored).

### `tmux_template`
Template for tmux session names. Variable: `{issue}` (number).

### `max_sessions`
Maximum number of concurrent agent sessions. Set based on machine resources.

### `max_verify_parallel`
Maximum number of concurrent verification pipelines. Default 1 to avoid resource contention during builds.

### `verify`
Ordered list of shell commands run in the task worktree before opening a PR. Fails fast on first error.

### `integration_rebuild`
Shell command run after merging into integration (via `foundry review`).

### `comment_triggers`
Strings matched in issue comments to trigger replan or restart.

### `version_sources`
**Ordered** list of `package.json` file paths (relative to repo root). All are bumped to the same version on `foundry release`. The first entry is the primary version source.

### `tag_prefix`
Prefix for release tags. Default `v` produces tags like `v1.2.3`.

### `poll_interval_seconds`
How often the runner polls GitHub for ready issues.

### `default_agent_backend`
Name of the backend to use when no label-based match is found.

### `agent_backends`
Map of backend definitions. Each backend has:
- `type`: Must be `command`
- `command`: Shell command with template variable interpolation
- `env` (optional): Environment variables (also support template interpolation)

### `agent_label_map`
Optional mapping from issue label names to backend names. When an issue has a matching label, that backend is used instead of the default.
