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

## `foundry setup-bot`

Create a GitHub App for Foundry and install it on your repos. This is the **recommended** way to authenticate Foundry — after running this command, no other auth setup is needed.

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

Scaffold `.joynt-foundry.yml` and create required GitHub labels.

```bash
foundry init [--skip-labels]
```

| Option | Description |
|--------|-------------|
| `--skip-labels` | Skip creating GitHub labels |

**What it does:**
- Detects the GitHub repo from `gh repo view`
- Creates `.joynt-foundry.yml` with sensible defaults
- Creates required labels: `state:ready`, `state:in-progress`, `state:done`, `state:ready-for-human-review`, `spec:changed`, `agent:claude`, `agent:cursor`

---

## `foundry run`

Start the runner loop: poll for ready issues, claim, spawn agent sessions.

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
- Respects `max_sessions` concurrency limit
- Handles SIGINT/SIGTERM for graceful shutdown
- On agent completion: verify → push → create PR

---

## `foundry status`

Show active tasks, sessions, branches, PRs, and agent backends.

```bash
foundry status
```

Displays per-task: issue number, title, status, branch, worktree, tmux session (alive/dead), backend, PR URL, and claim time.

---

## `foundry sessions`

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

## `foundry attach <target>`

Attach to a Foundry tmux session.

```bash
foundry attach 42              # by issue number
foundry attach foundry-42      # by session name
```

---

## `foundry stop <target>`

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

## `foundry reset <issue>`

Tear down all resources for a task and restore the issue to `state:ready`.

```bash
foundry reset 42               # dry-run (shows what would be removed)
foundry reset 42 --force       # actually execute
```

| Option | Description |
|--------|-------------|
| `--force` | Execute cleanup (default is dry-run) |

**Steps performed:**
1. Kill tmux session (if alive)
2. Remove worktree (if exists)
3. Delete local branch (if exists)
4. Delete remote branch (if exists)
5. Close PR (if open)
6. Remove foundry labels, add `state:ready`
7. Remove task from state

---

## `foundry prune`

Clean stale state, worktrees, and tmux sessions for completed/failed/stopped tasks.

```bash
foundry prune              # dry-run (shows what would be removed)
foundry prune --force      # actually remove
```

| Option | Description |
|--------|-------------|
| `--force` | Execute cleanup (default is dry-run) |

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
