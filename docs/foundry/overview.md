# Joynt Foundry — Overview

Foundry turns GitHub Issues into verified pull requests. It is the **orchestration layer** around a coding agent: it decides when an agent runs, where it runs, what happens to its output, and how a human steers it, all through labels and comments on the issue itself.

Foundry is not a coding agent. It launches one you configure (Claude Code by default) and declines to be one itself.

## Key concepts

| Concept | Description |
|---------|-------------|
| **Task** | A GitHub Issue that Foundry has claimed. Its lifecycle is a `state:*` label; exactly one is present at any time. |
| **Event** | Something that moves a task: a label added, an `@foundry` comment, a review requesting changes, a PR merged. |
| **Job / Runner** | Whatever executes Foundry in response to events: a GitHub Actions job (one per event) or an always-on `foundry run` / `foundry serve` process. |
| **Worker** | How the agent process is executed: as a subprocess of the job (Action) or in a tmux session (runner). |
| **Agent Backend** | The CLI command that does the coding. Pluggable; selected by config or by an `agent:*` label. |
| **Verification** | Lint, typecheck, build, and tests run in the worktree. No PR is opened until they pass. |
| **Integration Branch** | A moving `integration` branch that collects all feature PRs before promotion to `test` and `main`. |
| **Preview** | A per-task environment stood up when the PR opens and torn down when it merges, via a command or workflow you configure. |

## What Foundry does

1. **Claims** a `state:ready` issue: label swap plus a structured claim comment that doubles as the task's record.
2. **Isolates** the work in a git worktree on a feature branch cut from `origin/integration`.
3. **Launches** the configured agent with the issue as its brief.
4. **Classifies** the outcome from the agent's transcript: completed, needs input, plan ready, or errored.
5. **Verifies** the result. Failures are posted back to the issue.
6. **Opens a PR** into `integration` and labels the issue `state:ready-for-human-review`.
7. **Deploys a preview** and posts its URL on the PR.
8. **Listens** for the human: `@foundry` commands, review feedback, and the eventual merge, which marks the task `state:done` and tears the preview down.

## What Foundry does not do

- **It does not write code.** The agent does. Foundry runs it, gates it, and routes its output.
- **It does not host anything.** Previews are orchestrated by Foundry but deployed by a command or workflow you own.
- **It does not replace CI.** Verification is a pre-PR gate on the agent's branch. Your CI still runs on the PR.
- **It does not need a server.** As a GitHub Action, the only persistent state is on GitHub.

## Architecture

```
GitHub Issue (state:ready)
        │  event
        ▼
┌──────────────────────────────────────────┐
│ Foundry                                  │
│   claim ── worktree ── agent ── classify │
│                          │               │
│                          ▼               │
│                verify ── PR ── preview   │
└──────────────────────────────────────────┘
        │
        ▼
PR into integration  ◀── human review / @foundry ── ▶ agent resumes
        │ merge
        ▼
state:done · issue closed · preview down
```

The same `EventHandler` runs in both modes. What differs is how events arrive and where the agent runs:

| | GitHub Action | Always-on runner |
|---|---|---|
| Events | GitHub starts a job per event; `foundry action` reads the payload | `foundry run` polls; `foundry serve` receives webhooks |
| Agent | Subprocess of the job | tmux session on the runner machine |
| State | Rebuilt from GitHub every job (labels, claim comment, PR) | Files under `~/.joynt-foundry/` |
| Identity | Job token or GitHub App | GitHub App from `setup-bot` |

## Next steps

- [GitHub Action](github-action.md): the recommended way to run Foundry
- [Installation](installation.md)
- [Onboarding](onboarding.md)
- [Workflows](workflows.md): controlling the agent from the issue
- [Configuration Reference](config-reference.md)
