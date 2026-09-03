# Joynt Foundry — Overview

Foundry turns GitHub Issues into verified pull requests. It is the **orchestration layer** around a coding agent: it decides when an agent runs, where it runs, what happens to its output, and how a human steers it, all through labels and comments on the issue itself.

Foundry is a GitHub Action. It is not a coding agent, and it is not a server.

## Key concepts

| Concept | Description |
|---------|-------------|
| **Task** | A GitHub Issue that Foundry has claimed. Its lifecycle is a `state:*` label; exactly one is present at any time. |
| **Event** | Something that moves a task: a label added, an `@foundry` comment, a review requesting changes, a PR merged. Each one starts a job. |
| **Job** | One run of the Action for one event. It performs one transition and exits. Nothing persists between jobs except what is on GitHub. |
| **Agent Backend** | The CLI command that does the coding. Pluggable; selected by config or by an `agent:*` label. It runs as a subprocess of the job. |
| **Verification** | Lint, typecheck, build, and tests run in the worktree. No PR is opened until they pass. |
| **Integration Branch** | A moving `integration` branch that collects all feature PRs before promotion to `test` and `main`. |
| **Preview** | A per-task environment stood up when the PR opens and torn down when it merges, via a command or workflow you configure. |

## What Foundry does

1. **Claims** a `state:ready` issue: label swap plus a structured claim comment that doubles as the task's durable record.
2. **Isolates** the work in a git worktree on a feature branch cut from `origin/integration`.
3. **Launches** the configured agent with the issue as its brief.
4. **Classifies** the outcome from the agent's transcript: completed, needs input, plan ready, or errored.
5. **Verifies** the result. Failures are posted back to the issue.
6. **Opens a PR** into `integration` and labels the issue `state:ready-for-human-review`.
7. **Deploys a preview** and posts its URL on the PR.
8. **Listens** for the human. Each `@foundry` command, review, or merge is a new event and a new job: relaunch the agent with the human's message, mark the task `state:done`, tear the preview down.

## What Foundry does not do

- **It does not write code.** The agent does. Foundry runs it, gates it, and routes its output.
- **It does not host anything.** Previews are orchestrated by Foundry but deployed by a command or workflow you own.
- **It does not replace CI.** Verification is a pre-PR gate on the agent's branch. Your CI still runs on the PR.
- **It does not keep state anywhere but GitHub.** A job rebuilds the task from the issue every time. Delete the runner, nothing is lost.

## Architecture

```
GitHub event (label · comment · review · merge)
        │
        ▼  one Actions job
┌───────────────────────────────────────────────┐
│ foundry action                                │
│   recover task from GitHub                    │
│   map event → FoundryEvent                    │
│   EventHandler: claim · worktree · agent      │
│                 classify · verify · PR        │
│                 preview · labels · comments   │
└───────────────────────────────────────────────┘
        │
        ▼
labels · claim comment · status comment · PR · preview comment
                        (the state)
```

Everything a later job needs to know is written to GitHub before the current one exits. `lib/task-recovery.ts` reads it back: the claim comment gives branch and backend, the `state:*` label gives status, the PR lookup gives the PR, the preview comment gives the URL.

## Next steps

- [GitHub Action](github-action.md): the workflow, the secrets, and the decisions behind them
- [Installation](installation.md)
- [Onboarding](onboarding.md)
- [Workflows](workflows.md): controlling the agent from the issue
- [Configuration Reference](config-reference.md)
