# Configuration Reference

Foundry is configured via `.joynt-foundry.yml` at the repo root of the repository the Action runs in.

Every key with its default, annotated, is in [example.joynt-foundry.yml](../../example.joynt-foundry.yml); `foundry init` writes the same file with project-specific defaults filled in. This page explains each key.

## Field Reference

### `repo` (required)
GitHub repository in `owner/repo` format.

### `labels`
Label names Foundry uses to show task state. Customize if your repo uses different label conventions. Only Foundry adds or removes them; a human adding one changes nothing.

### `mode_labels`
Label names that control agent permission mode, applied by a human before `@foundry go`. `plan` makes the agent produce a plan for approval before implementing. `auto` (the default when no label is present) gives the agent full permissions. `default` is the agent's own step-by-step mode, which asks before tool use; under the Action nobody is there to answer, so it is only useful with a backend that does not prompt.

### `branches`
The repo's long-lived branches, by name. `integration` is the moving branch feature branches are cut from and merged into; `production` is what it is promoted to (`foundry sync-integration` merges it back). Defaults `integration` and `main`. Set them to whatever the repo already deploys from: Foundry never asks a repo to rename a branch that its hosting, protection rules, or deploy workflows key on. The integration branch must exist on the remote; a `@foundry go` on a repo whose configured branch is missing is refused with the reason on the issue, never silently based on production.

### `branch_template`
Template for feature branch names. Variables: `{issue}` (number), `{slug}` (slugified title, max 40 chars).

### `worktree_base`
Base directory for git worktrees. Resolved relative to the repo root. Default: `./wts` (inside the repo, gitignored).

### `max_input_rounds`
Maximum number of human-input rounds (including PR review feedback rounds) before the agent gives up and marks the task failed. Default 3.

### `agent_max_turns`
Cap on agent turns per run, exported as `FOUNDRY_MAX_TURNS`; the Claude Code preset passes it as `--max-turns`. A run that hits it ends with an error result and the task fails. Default 150.

### `reconcile_stale_minutes`
`foundry reconcile` (the `schedule` trigger) marks an in-progress issue failed when its status comment has not changed for this long. Set it above the workflow's `timeout-minutes`. Default 120.

### `verify`
Ordered list of shell commands run in the task worktree before opening a PR. Fails fast on first error.

### `integration_rebuild`
Shell command run after merging into integration (via `foundry review`).

### `verify_preview`
Ordered list of shell commands run **against the live preview** after it is up, in the branch's worktree, with `FOUNDRY_PREVIEW_URL` in the environment (plus `FOUNDRY_BRANCH`, `FOUNDRY_PR_NUMBER`, `FOUNDRY_ISSUE`). Fail-fast. Foundry first waits for the URL to answer (`preview.ready_timeout_seconds`). A task is not marked `state:ready-for-human-review` until these pass; a failure fails the task with the output on the issue, and the branch is pushed so `@foundry go` can send the agent back to it. Also runs for non-task PRs previewed via `pull_request_bases`, with the result posted on the PR. Default `[]`. See [Preview Environments](preview-environments.md#verifying-against-the-preview).

### `comment_triggers`
The three strings that, at the start of an issue comment, start or stop work. `go` takes a message: everything after the trigger, same line or following lines. `restart` and `stop` must be the first line on their own. Every other comment is context for the agent's next launch and starts nothing. Only commenters with write access to the repo are obeyed. See [The three commands](workflows.md#the-three-commands).

### `version_sources`
**Ordered** list of version file paths (relative to repo root). All are bumped to the same version on `foundry release`. The first entry is the primary version source. Supported file types: `package.json`, `Cargo.toml`, `pyproject.toml`.

### `tag_prefix`
Prefix for release tags. Default `v` produces tags like `v1.2.3`.

### `default_agent_backend`
Name of the backend to use when no label-based match is found.

### `agent_backends`
Map of backend definitions. Each backend has:
- `type`: Must be `command`
- `preset`: `claude-code` uses the command Foundry maintains, so config never carries a stale copy
- `command`: Shell command with template variable interpolation. Required without `preset`; overrides it when both are set. It must end the run with an [agent report](agent-backends.md#the-agent-report).
- `env` (optional): Environment variables (also support template interpolation)

There is no resume command. When a human answers or requests changes, the agent is relaunched with the message as its brief; sessions do not survive jobs.

### `agent_label_map`
Optional mapping from issue label names to backend names. When an issue has a matching label, that backend is used instead of the default.

### `preview`
Configuration for preview/staging environments deployed per-task.

- `mode` — `"template"` or `"provider"`. In `template` mode no command runs; the URL comes from `url_template`. In `provider` mode `up_command` runs to deploy and `down_command` to tear down.
- `url_template` — When set, this is **always** the preview URL in either mode; command output is ignored. Only when it is absent does provider mode read the URL from the command's stdout. Template variables: `{branch}`, `{branch_slug}`, `{issue}`, `{repo}`, `{pr_number}`, `{sha}`. Also exposed as env vars `FOUNDRY_BRANCH`, `FOUNDRY_BRANCH_SLUG`, `FOUNDRY_ISSUE`, `FOUNDRY_REPO`, `FOUNDRY_PR_NUMBER`, `FOUNDRY_SHA`.
- `up_command` — Shell command to spin up the preview environment (`provider` mode). Without `url_template` it must print a URL, or JSON `{ "url": "..." }`, to stdout. Same template variables. Under the Action, `gh` is available and `GH_TOKEN` is set, so `gh workflow run your-deploy.yml -f pr={pr_number}` is the common shape; it needs `actions: write`.
- `down_command` — Shell command to tear down the preview environment (`provider` mode). Same template variables.
- `comment` — Whether to post/update a PR comment with the preview URL. Default `true`.
- `ready_timeout_seconds` — How long `verify_preview` waits for the preview URL to answer before giving up. Default `300`.
- `ready_match` — Text the preview's body must contain before it counts as up; `{sha}`, `{branch}`, `{pr_number}` are expanded. Without it, a redeploy is verified against the previous version that is still being served. Have the page print its commit and set `"{sha}"`.
- `pull_request_bases` — Base branches whose pull requests get a preview even when they are not Foundry tasks (up on open, redeploy on push, down on close). Typically `[main]` for the promotion PR from `integration`. See [Preview Environments](preview-environments.md#previews-for-pull-requests-that-are-not-tasks).

### `github_deployments`
Configuration for creating GitHub Deployment objects alongside preview environments.

- `enabled` — Whether to create GitHub Deployments. Default `false`.
- `environment` — GitHub environment name used for the deployment (e.g. `"preview"`, `"staging"`). Default `"preview"`.
- `production` — Whether the environment is a production environment. Default `false`.
- `auto_inactive` — Whether to mark the deployment `inactive` when the preview is torn down. Default `true`. Under the Action the deployment id is not carried between jobs, so this only takes effect for `foundry preview down` run from the job that created it; have the teardown workflow mark its own deployment inactive.

### `review`
- `merge_on_approval` — An approving review on a task PR, or a promotion PR into a `preview.pull_request_bases` branch, rebases the branch onto its base, re-runs `verify` on the rebased head and publishes a fresh `Foundry Verification` check run for it, waits for checks, merges with the rebase method, and runs `integration_rebuild`. Default `true`. See [GitHub Action](github-action.md#decisions-and-gotchas).
- `checks_timeout_seconds` — How long to wait for the PR's checks after the rebase. Default `900`.

### `github_backend`
Which GitHub API backend to use. Options:
- `octokit` (default) — uses `@octokit/rest`. Recommended for automation and CI/containers.
- `gh-cli` — uses the `gh` CLI. Convenient for local dev if `gh` is installed and authenticated.

Override priority: `--github-backend` CLI flag > `FOUNDRY_GITHUB_BACKEND` env var > config file.

See [GitHub Backends](github-backends.md) for detailed setup.
