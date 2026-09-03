# Configuration Reference

Foundry is configured via `.joynt-foundry.yml` at the repo root. The same file serves both the GitHub Action and the always-on runner; keys that only make sense for a long-lived runner are marked **runner only** and are ignored by the Action.

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
  waiting_for_input: "state:waiting-for-input"  # Agent needs human input
  failed: "state:failed"                # Task failed
  plan_review: "state:plan-review"       # Agent produced a plan, awaiting approval
  claim: "state:claim"                  # Claim-only: set up worktree without starting agent

# ── Mode Labels (optional) ──────────────────────────────────────────

mode_labels:
  plan: "mode:plan"                     # Issue runs agent in plan mode
  auto: "mode:auto"                     # Issue runs agent in auto mode (default)
  default: "mode:default"               # Issue runs agent in default permission mode

# ── Branching & Worktrees ────────────────────────────────────────────

branch_template: "feature/{issue}-{slug}"   # {issue} = number, {slug} = slugified title
worktree_base: "./wts"                      # Relative to repo root or absolute
tmux_template: "foundry-{issue}"            # {issue} = number

# ── Concurrency ──────────────────────────────────────────────────────

max_sessions: 4                         # Max concurrent agent sessions
max_verify_parallel: 1                  # Max concurrent verification pipelines
max_input_rounds: 3                     # Max human-input rounds before giving up

# ── Verification ─────────────────────────────────────────────────────

verify:                                 # Commands run before PR creation
  - "npm run lint"
  - "npm run typecheck"
  - "npm run build"
  - "npm test"

integration_rebuild: "npm run build"    # Command run after integration merge

# ── Comment Triggers ─────────────────────────────────────────────────

comment_triggers:
  replan: "@foundry replan"             # Kill agent, re-read issue, relaunch
  restart: "@foundry restart"           # Discard work, re-queue as ready
  stop: "@foundry stop"                 # Kill agent, mark failed
  continue: "@foundry continue"         # Resume agent with message
  plan: "@foundry plan"                 # Relaunch in plan mode
  start: "@foundry start"              # Re-queue a failed/stopped task
  claim: "@foundry claim"              # Claim issue without starting agent (comment trigger)

# ── Versioning ───────────────────────────────────────────────────────

version_sources:                        # Ordered list of version file paths
  - "package.json"                      # First = primary (version read from here)
  - "packages/api/package.json"         # Supported: package.json, Cargo.toml, pyproject.toml
  - "packages/web/package.json"

tag_prefix: "v"                         # Release tag prefix (e.g. v1.2.3)

# ── Polling (runner only) ────────────────────────────────────────────

poll_interval_seconds: 30               # Seconds between issue polls in `foundry run`

# ── Execution (runner only) ──────────────────────────────────────────

worker:
  type: "local-tmux"                    # or "subprocess"; the Action always uses subprocess

state_store:
  type: "file"                          # the only implementation; ~/.joynt-foundry/

# ── GitHub Backend ──────────────────────────────────────────────────

github_backend: "octokit"              # "octokit" (default) or "gh-cli"
                                        # Override with FOUNDRY_GITHUB_BACKEND env var
                                        # or --github-backend CLI flag

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
  # "agent:aider": "aider"          # any backend defined above

# ── Preview Environments (optional) ─────────────────────────────────

preview:
  mode: "template"                        # "template" = URL only, no command; "provider" = run up/down commands
  url_template: "https://pr-{issue}.preview.example.com"   # when set, always the URL (both modes)
  # up_command: "deploy.sh up {issue} {branch}"   # mode:provider — deploy command
  # down_command: "deploy.sh down {issue} {branch}"  # mode:provider — teardown command
  comment: true                           # Post/update PR comment (default true)

# ── GitHub Deployments (optional) ───────────────────────────────────

github_deployments:
  enabled: false                          # Default false
  environment: "preview"                  # GitHub environment name
  production: false                       # Whether this is a production environment
  auto_inactive: true                     # Mark deployment inactive on teardown
```

## Field Reference

### `repo` (required)
GitHub repository in `owner/repo` format.

### `labels`
Label names used by Foundry to track task state. Customize if your repo uses different label conventions. Includes `plan_review` for the plan-review workflow and `claim` for the claim-only workflow (claim without starting an agent).

### `mode_labels`
Label names that control agent permission mode. Apply one of these labels to an issue to override the default auto mode. `plan` makes the agent produce a plan for approval before implementing. `default` uses Claude Code's default permission mode (asks before tool use).

### `branch_template`
Template for feature branch names. Variables: `{issue}` (number), `{slug}` (slugified title, max 40 chars).

### `worktree_base`
Base directory for git worktrees. Resolved relative to the repo root. Default: `./wts` (inside the repo, gitignored).

### `tmux_template` (runner only)
Template for tmux session names. Variable: `{issue}` (number). The Action uses the same string as the worker id but no tmux is involved.

### `max_sessions` (runner only)
Maximum number of concurrent agent sessions on one runner. Under the Action, concurrency is one job per issue via the workflow's `concurrency` group.

### `max_verify_parallel` (runner only)
Maximum number of concurrent verification pipelines. Default 1 to avoid resource contention during builds.

### `max_input_rounds`
Maximum number of human-input rounds (including PR review feedback rounds) before the agent gives up and marks the task failed. Default 3.

### `verify`
Ordered list of shell commands run in the task worktree before opening a PR. Fails fast on first error.

### `integration_rebuild`
Shell command run after merging into integration (via `foundry review`).

### `comment_triggers`
Strings matched in issue comments to trigger agent commands. The runner checks on every poll cycle; the Action reacts to the `issue_comment` event immediately. Commands that accept a message (`continue`, `start`, `plan`) match as a prefix — everything after the trigger string becomes the message. See [Controlling Foundry](workflows.md#controlling-foundry) for the full command reference.

### `version_sources`
**Ordered** list of version file paths (relative to repo root). All are bumped to the same version on `foundry release`. The first entry is the primary version source. Supported file types: `package.json`, `Cargo.toml`, `pyproject.toml`.

### `tag_prefix`
Prefix for release tags. Default `v` produces tags like `v1.2.3`.

### `poll_interval_seconds` (runner only)
How often `foundry run` polls GitHub for ready issues. `foundry serve` and the Action are event-driven.

### `worker` (runner only)
How the agent process is executed. `local-tmux` (default) runs it in a tmux session you can `foundry attach` to. `subprocess` runs it as a child of the Foundry process, streaming output to stdout. `foundry action` always uses `subprocess` regardless of this setting.

### `state_store` (runner only)
Where task state is persisted. `file` (the only implementation) writes atomically under `~/.joynt-foundry/`. The Action starts every job with an empty store and rebuilds tasks from GitHub.

### `default_agent_backend`
Name of the backend to use when no label-based match is found.

### `agent_backends`
Map of backend definitions. Each backend has:
- `type`: Must be `command`
- `command`: Shell command with template variable interpolation
- `env` (optional): Environment variables (also support template interpolation)

### `agent_label_map`
Optional mapping from issue label names to backend names. When an issue has a matching label, that backend is used instead of the default.

### `preview`
Configuration for preview/staging environments deployed per-task.

- `mode` — `"template"` or `"provider"`. In `template` mode no command runs; the URL comes from `url_template`. In `provider` mode `up_command` runs to deploy and `down_command` to tear down.
- `url_template` — When set, this is **always** the preview URL in either mode; command output is ignored. Only when it is absent does provider mode read the URL from the command's stdout. Template variables: `{branch}`, `{issue}`, `{repo}`, `{pr_number}`, `{sha}`. Also exposed as env vars `FOUNDRY_BRANCH`, `FOUNDRY_ISSUE`, `FOUNDRY_REPO`, `FOUNDRY_PR_NUMBER`, `FOUNDRY_SHA`.
- `up_command` — Shell command to spin up the preview environment (`provider` mode). Without `url_template` it must print a URL, or JSON `{ "url": "..." }`, to stdout. Same template variables. Under the Action, `gh` is available and `GH_TOKEN` is set, so `gh workflow run your-deploy.yml -f pr={pr_number}` is the common shape; it needs `actions: write`.
- `down_command` — Shell command to tear down the preview environment (`provider` mode). Same template variables.
- `comment` — Whether to post/update a PR comment with the preview URL. Default `true`.

### `github_deployments`
Configuration for creating GitHub Deployment objects alongside preview environments.

- `enabled` — Whether to create GitHub Deployments. Default `false`.
- `environment` — GitHub environment name used for the deployment (e.g. `"preview"`, `"staging"`). Default `"preview"`.
- `production` — Whether the environment is a production environment. Default `false`.
- `auto_inactive` — Whether to automatically mark the deployment as `inactive` when the preview is torn down. Default `true`.

### `github_backend`
Which GitHub API backend to use. Options:
- `octokit` (default) — uses `@octokit/rest`. Recommended for automation and CI/containers.
- `gh-cli` — uses the `gh` CLI. Convenient for local dev if `gh` is installed and authenticated.

Override priority: `--github-backend` CLI flag > `FOUNDRY_GITHUB_BACKEND` env var > config file.

See [GitHub Backends](github-backends.md) for detailed setup.
