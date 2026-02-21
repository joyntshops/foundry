# CLI Reference

## Global Options

```
foundry [options] [command]

Options:
  -V, --version     Output version number
  -v, --verbose     Enable verbose/debug output
  -h, --help        Display help
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

List Foundry tmux sessions with mapped task info.

```bash
foundry sessions
```

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
```

Sends Ctrl+C, waits 2 seconds, then kills the tmux session. Marks the task as `stopped`.

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
