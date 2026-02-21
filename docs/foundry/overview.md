# Joynt Foundry — Overview

Foundry is a developer automation system that uses **GitHub Issues** as the task control plane and orchestrates concurrent local **agent sessions** to implement tasks on git worktrees, run pre-integration validation, and open PRs into a moving `integration` branch.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Task** | A GitHub Issue labeled `state:ready` |
| **Runner** | A local `foundry run` process that polls for tasks |
| **Agent Backend** | A pluggable CLI coding agent (Claude Code, Cursor, or any custom command) |
| **Session** | A tmux session containing an agent working in a git worktree |
| **Verification** | Lint, typecheck, build, and unit tests run before PR creation |
| **Integration Branch** | A moving `integration` branch that collects all feature PRs |

## What Foundry Does

1. **Polls** GitHub Issues for tasks labeled `state:ready`
2. **Claims** tasks safely (label swap + structured comment + verification)
3. **Creates** a git worktree and feature branch for each task
4. **Launches** a coding agent in a tmux session inside the worktree
5. **Verifies** the agent's output (lint/typecheck/build/tests)
6. **Opens a PR** targeting the `integration` branch
7. **Supports** review, release, and hotfix workflows

## What Foundry Does NOT Do

- **No runtime testing** — manual runtime testing happens outside Foundry
- **No deployment** — Foundry creates PRs; deployment is a separate concern
- **No CI/CD** — Foundry runs locally; CI/CD lives in GitHub Actions or similar

## Architecture

```
GitHub Issues (state:ready)
        │
        ▼
   foundry run  ─── poll loop
        │
        ├── claim issue (label + comment + verify)
        ├── create worktree + branch
        ├── launch agent in tmux session
        │       │
        │       ▼
        │   agent works on task...
        │       │
        │       ▼
        ├── verify (lint/build/test)
        └── open PR → integration
```

## Next Steps

- [Installation](installation.md)
- [Onboarding](onboarding.md)
- [CLI Reference](cli-reference.md)
- [Configuration Reference](config-reference.md)
