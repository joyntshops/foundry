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

Developer automation system. GitHub Issues become the task control plane; Foundry claims tasks, launches pluggable coding agents in isolated git worktrees, runs pre-integration validation, and opens PRs into a moving `integration` branch.

## Quick Start

```bash
npm install -g @joynt/foundry
cd your-repo
foundry init
foundry run
```

## Commands

| Command | Description |
|---------|-------------|
| `foundry init` | Scaffold config and create GitHub labels |
| `foundry run` | Poll → claim → spawn agent sessions |
| `foundry status` | Show active tasks and sessions |
| `foundry sessions` | List tmux sessions |
| `foundry attach <issue>` | Attach to an agent session |
| `foundry stop <issue>` | Stop a session safely |
| `foundry prune` | Clean stale state and worktrees |
| `foundry review <pr>` | Rebase, merge into integration, rebuild |
| `foundry release <type>` | Unified version bump (patch/minor/major) |
| `foundry sync-integration` | Merge main into integration after hotfix |

## Documentation

- [Overview](docs/foundry/overview.md)
- [Installation](docs/foundry/installation.md)
- [Onboarding](docs/foundry/onboarding.md)
- [Workflows](docs/foundry/workflows.md)
- [Integration Strategy](docs/foundry/integration-strategy.md)
- [Agent Backends](docs/foundry/agent-backends.md)
- [CLI Reference](docs/foundry/cli-reference.md)
- [Configuration Reference](docs/foundry/config-reference.md)
- [Troubleshooting](docs/foundry/troubleshooting.md)

## Package

Published to GitHub Packages as `@joynt/foundry`. See [installation docs](docs/foundry/installation.md) for authentication setup.
