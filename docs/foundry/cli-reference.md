# CLI Reference

## Global Options

```
foundry [options] [command]

Options:
  -V, --version                    Output version number
  -v, --verbose                    Enable verbose/debug output
  --github-backend <backend>       GitHub backend: gh-cli or octokit (env: FOUNDRY_GITHUB_BACKEND)
  -h, --help                       Display help
```

---

Commands marked **runner** act on the local state of an always-on `foundry run` / `foundry serve` process and have no meaning inside a GitHub Actions job. Everything else works in both modes.

---

## `foundry action`

Run the state machine for **one GitHub event** and exit. This is the entry point of the composite GitHub Action (`action.yml`); you rarely invoke it by hand.

```bash
foundry action [--event-name <name>] [--event-path <file>]
```

| Option | Description |
|--------|-------------|
| `--event-name` | GitHub event name. Default: `$GITHUB_EVENT_NAME` |
| `--event-path` | Path to the event JSON payload. Default: `$GITHUB_EVENT_PATH` |

**What it does:**
1. Loads `.joynt-foundry.yml` from the current directory (the checkout)
2. Rebuilds the referenced task from GitHub (claim comment, labels, PR, preview comment) since local state is empty in a fresh job
3. Maps the payload to Foundry events and dispatches them through the same handler `run` uses
4. If a handler launched an agent, waits for it as a subprocess, classifies the outcome, and continues
5. Writes `issue`, `status`, `branch`, `pr-url`, `log-dir`, `log-path` to `$GITHUB_OUTPUT`

Useful locally as a dry run against a saved payload: any event that maps to nothing exits 0 after recovery, which checks auth and config. See [GitHub Action](github-action.md).

---

## `foundry setup-bot` (runner)

Create a GitHub App for Foundry and install it on your repos. For the always-on runner this is the **recommended** way to authenticate — after running this command, no other auth setup is needed. Under the GitHub Action it is optional: the job's own token works, and an App adds a named bot identity.

```bash
foundry setup-bot
```

**What it does:**
1. Opens your browser to GitHub's App creation page (auto-filled manifest)
2. You click "Create" — GitHub creates the App
3. Opens the installation page — you select which repos to grant access
4. Saves credentials to `~/.joynt-foundry/github-app-{org}.*`
5. Verifies API access

**After setup:**
- `foundry run` auto-detects the App and uses it — no flags, no env vars
- Actions appear as `Foundry Bot[bot]` on GitHub
- Tokens are auto-managed (generated from the private key, refreshed automatically)

**For CI**, set these env vars instead of running `setup-bot`:
```bash
export FOUNDRY_GITHUB_APP_ID=<app-id>
export FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH=/path/to/key.pem
export FOUNDRY_GITHUB_APP_INSTALLATION_ID=<installation-id>
```

---

## `foundry init`

Scaffold `.joynt-foundry.yml`, create required GitHub labels, and create the `integration` branch.

```bash
foundry init [--skip-labels] [--clean-labels]
```

| Option | Description |
|--------|-------------|
| `--skip-labels` | Skip creating GitHub labels |
| `--clean-labels` | Remove non-Foundry labels before creating Foundry labels |

**What it does:**
- Detects the GitHub repo from `gh repo view`
- Creates `.joynt-foundry.yml` with sensible defaults
- Creates the `state:*` and `mode:*` labels (see [Onboarding](onboarding.md) for the list), plus `agent:*` labels when `agent_label_map` has two or more entries
- Creates and pushes the `integration` branch if missing

---

## `foundry run` (runner)

Start the runner loop: poll for ready issues, claim, spawn agent sessions in tmux.

```bash
foundry run [--once]
```

| Option | Description |
|--------|-------------|
| `--once` | Run a single poll cycle then exit |

**Behavior:**
- Auth is automatic after `foundry setup-bot` — no additional config needed
- Reconciles state on startup (marks dead sessions as stopped)
- Polls every `poll_interval_seconds` (default: 30s)
- Detects `state:ready` issues → claims and launches agent immediately
- Detects `state:claim` issues → claims without starting agent (direct via `@foundry plan`, `@foundry continue`, etc.)
- Respects `max_sessions` concurrency limit
- Handles SIGINT/SIGTERM for graceful shutdown
- On agent completion: verify → push → create PR

---

## `foundry serve` (runner)

Start an HTTP server that receives GitHub webhooks and dispatches them as events, with a reconciliation poll every five minutes as a fallback for missed deliveries.

```bash
foundry serve [--port 3000] [--host 0.0.0.0]
```

Endpoints: `POST /webhook` (signature verified with the App's webhook secret from `~/.joynt-foundry/github-app-{org}.json`), `GET /health`, `GET /status`. The machine must be reachable from GitHub; for a laptop or a box behind NAT, use the GitHub Action instead.

---

## `foundry status` (runner)

Show active tasks, sessions, branches, PRs, and agent backends.

```bash
foundry status
```

Displays per-task: issue number, title, status, branch, worktree, tmux session (alive/dead), backend, PR URL, and claim time.

---

## `foundry sessions` (runner)

Show a unified task dashboard for all tracked tasks and their resources.

```bash
foundry sessions               # active tasks only
foundry sessions --all         # include terminal tasks (done/failed/stopped)
foundry sessions --local       # skip GitHub API calls, show local state only
```

| Option | Description |
|--------|-------------|
| `--all` | Include terminal tasks (`done`, `failed`, `stopped`) |
| `--local` | Skip GitHub API calls, only show local resource state |

**Columns:** Issue, Status, tmux (alive/dead), Worktree (exists/—), PR (OPEN/MERGED/CLOSED), Labels (foundry labels from GitHub).

---

## `foundry attach <target>` (runner)

Attach to a Foundry tmux session.

```bash
foundry attach 42              # by issue number
foundry attach foundry-42      # by session name
```

---

## `foundry stop <target>` (runner)

Stop a Foundry session safely.

```bash
foundry stop 42                # by issue number
foundry stop foundry-42        # by session name
foundry stop 42 --ready        # stop and restore state:ready label
```

| Option | Description |
|--------|-------------|
| `--ready` | Restore the `state:ready` label so the runner re-claims immediately |

Sends Ctrl+C, waits 2 seconds, then kills the tmux session. Without `--ready`, marks the task as `stopped` and adds the `state:failed` label. With `--ready`, restores `state:ready` for re-claiming.

---

## `foundry reset [issue]` (runner)

Tear down all resources (local + remote) for a task and restore the issue to `state:ready`. This is the "nuclear option" — full cleanup including GitHub resources.

```bash
foundry reset 42               # dry-run (shows what would be removed)
foundry reset 42 --force       # actually execute
foundry reset --all            # dry-run all known tasks
foundry reset --all --force    # reset every tracked task
```

| Option | Description |
|--------|-------------|
| `--force` | Execute cleanup (default is dry-run) |
| `--all` | Reset all known tasks (discovers issues from task directories and state) |

**Steps performed (per task):**
1. Kill tmux session (if alive)
2. Remove worktree (if exists)
3. Delete local branch (if exists)
4. Delete remote branch (if exists)
5. Close PR (if open)
6. Remove foundry labels, add `state:ready`
7. Remove task from state

When using `--all`, Foundry discovers issues from `~/.joynt-foundry/tasks/{repo}/` subdirectories and the state JSON. Each discovered task goes through the full reset sequence.

---

## `foundry prune` (runner)

Clean **local** runner resources (tmux sessions, worktrees, local branches, state) for completed/failed/stopped tasks. Does **not** touch remote branches, PRs, or GitHub labels — use `foundry reset` for full teardown.

```bash
foundry prune              # dry-run (shows what would be removed)
foundry prune --all        # actually remove
```

| Option | Description |
|--------|-------------|
| `--all` | Execute cleanup (default is dry-run) |
| `--force` | Alias for `--all` (backwards compat) |

---

## `foundry preview up <issue>`

Trigger a preview deployment for a task. Spins up a preview environment using the configured `preview` settings and posts the preview URL as a PR comment.

```bash
foundry preview up 42
```

## `foundry preview down <issue>`

Tear down a preview environment for a task. Removes the preview deployment and marks any GitHub Deployment as inactive (if `github_deployments.auto_inactive` is enabled).

```bash
foundry preview down 42
```

## `foundry preview status <issue>`

Show preview environment status including the preview URL, GitHub Deployment ID, and current state.

```bash
foundry preview status 42
```

**Example workflow:**

```bash
# Spin up a preview for issue 42
foundry preview up 42
# => Preview deployed: https://pr-42.preview.example.com

# Check the current preview state
foundry preview status 42
# => Issue: 42
# => URL:   https://pr-42.preview.example.com
# => State: active

# Tear down when done
foundry preview down 42
# => Preview for issue 42 torn down
```

---

## `foundry review <target>`

Review and merge a PR into integration.

```bash
foundry review 42              # by PR/issue number
foundry review https://...     # by URL
```

**Flow:**
1. Check mergeability
2. Rebase feature branch onto integration
3. Push rebased branch
4. Merge into integration
5. Run integration rebuild command
6. Label issue `state:ready-for-human-review`

---

## `foundry release <type>`

Bump unified version across all configured `version_sources`.

```bash
foundry release patch
foundry release minor
foundry release major
```

Must be on the `integration` branch. Commits and pushes the version bump.

---

## `foundry sync-integration`

Merge updated `main` into `integration` after hotfix releases.

```bash
foundry sync-integration
```

Must be on the `integration` branch. Fetches latest, merges `origin/main`, pushes.
