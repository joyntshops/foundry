# Joynt Foundry

```
                    (
               (     )  )
                )   (  (
               (     ) . )
              .  )  (    (
              )  . )  )   )
             (  (    (  . (
            . )   )   )
             (___(___(________________________
             |                                |
             |                                |
             |        JOYNT  FOUNDRY          |
             |        ~~~~~~~~~~~~~~          |
             |        the code forge          |
             |                                |
             |                                |
             |    :ready            → claim   |
             |    worktree          → agent   |
             |    lint · build      → test    |
             |    verify            → PR      |
             |                                |
             |                                |
          ___|________________________________|___
         /  ____                            ____  \
        /  /    \                          /    \  \
       /__/ ~~~~ \________________________/ ~~~~ \__\
          \______/                        \______/
      ==============================================
       issue ──▶ agent ──▶ verify ──▶ integration
```

GitHub Issues are the task control plane. Label an issue `state:ready` and Foundry claims it, runs a coding agent in an isolated git worktree, verifies the result, opens a PR into a moving `integration` branch, and stands up a preview environment. Humans review on GitHub. Every control is an issue label or an `@foundry` comment.

Foundry is a **GitHub Action**. There is no server to run and no machine to keep awake. Every GitHub event that matters starts a job, the job performs one transition of the task's state machine, and state lives on GitHub: in labels, a structured claim comment, the PR, and the preview comment.

Foundry is the orchestration layer, not the agent. It runs Claude Code, aider, or any CLI you configure, and bills your own Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN`.

## Quick start

1. **Labels and config.** From a clone, run `npx @joyntshops/foundry init` (see [Installation](docs/foundry/installation.md) for registry auth). It creates the `state:*` and `mode:*` labels, a `.joynt-foundry.yml`, and the `integration` branch. Or do those by hand from [Onboarding](docs/foundry/onboarding.md).
2. **Workflow.** Add `.github/workflows/foundry.yml` from the template in [GitHub Action](docs/foundry/github-action.md) and commit it to the default branch.
3. **Secret.** Add `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Optionally add a GitHub App so Foundry's comments carry a bot name.
4. **Go.** Open an issue, add the label `state:ready`, watch Actions → Foundry.

## The loop

```
issue labeled state:ready
  → claim (label swap + claim comment)
  → worktree from origin/integration
  → agent runs; transcript is the job log
  → outcome classified: completed · needs input · plan ready · errored
  → verify (lint, typecheck, build, test); no PR until green
  → PR into integration · state:ready-for-human-review · preview up
human reviews, comments @foundry, or requests changes → agent resumes
PR merged → state:done · issue closed · preview down
```

## CLI

The CLI sets a repo up and operates on tasks from any checkout. It is not a daemon.

| Command | Description |
|---------|-------------|
| `foundry init` | Scaffold config, create labels, create `integration` branch |
| `foundry setup-bot` | Create a GitHub App so Foundry acts under its own name (optional) |
| `foundry action` | Run the state machine for one GitHub event; the Action's entry point |
| `foundry reset <issue>` | Remove a task's branch, PR, and preview; set it back to `state:ready` |
| `foundry preview up/down/status <issue>` | Manage a task's preview environment by hand |
| `foundry review <pr>` | Rebase a PR onto `integration`, merge it, run the integration rebuild |
| `foundry release <type>` | Unified version bump across `version_sources` |
| `foundry sync-integration` | Merge `main` into `integration` after a hotfix |

See [CLI Reference](docs/foundry/cli-reference.md).

## Documentation

- [Overview](docs/foundry/overview.md)
- [GitHub Action](docs/foundry/github-action.md)
- [Installation](docs/foundry/installation.md)
- [Onboarding](docs/foundry/onboarding.md)
- [Workflows](docs/foundry/workflows.md)
- [Integration Strategy](docs/foundry/integration-strategy.md)
- [Preview Environments](docs/foundry/preview-environments.md)
- [Agent Backends](docs/foundry/agent-backends.md)
- [GitHub Identity](docs/foundry/github-backends.md)
- [CLI Reference](docs/foundry/cli-reference.md)
- [Configuration Reference](docs/foundry/config-reference.md)
- [Troubleshooting](docs/foundry/troubleshooting.md)

## Package

Published to GitHub Packages as `@joyntshops/foundry`. Merging to `main` publishes automatically. See [Installation](docs/foundry/installation.md) for registry authentication.

## License

MIT. See [LICENSE](LICENSE).
