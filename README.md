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

Foundry is the orchestration layer, not the agent. It runs Claude Code, aider, or any CLI you configure.

## Two ways to run it

| | **GitHub Action** (recommended) | **Always-on runner** |
|---|---|---|
| Where it runs | A GitHub Actions job per event. Nothing to host. | A machine you keep awake: `foundry run` (polling) or `foundry serve` (webhooks) |
| What you install | Nothing on any machine; `uses: joyntshops/foundry@main` | `npm install -g @joyntshops/foundry`, plus git, tmux, gh |
| GitHub identity | The job's built-in token, or a GitHub App | A GitHub App from `foundry setup-bot` |
| Agent billing | Your Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN` | Whatever the agent CLI is logged in as |
| Reacts to events | Immediately, per event | Every `poll_interval_seconds` (`run`) or immediately (`serve`) |
| Watch the agent | Job log + transcript artifact | `foundry attach` to the tmux session |

Start with the Action. The runner exists for machines that must stay inside a private network, or for interactive `attach` sessions.

## Quick start: GitHub Action

1. **Labels.** Foundry needs its `state:*` and `mode:*` labels on the repo. Run `foundry init` once from a clone (see [Installation](docs/foundry/installation.md) for registry auth), or create them by hand from the list in [Onboarding](docs/foundry/onboarding.md).
2. **Config.** Commit a `.joynt-foundry.yml` at the repo root. `foundry init` scaffolds one; [example.joynt-foundry.yml](example.joynt-foundry.yml) is a commented reference.
3. **Workflow.** Add `.github/workflows/foundry.yml` from the template in [GitHub Action](docs/foundry/github-action.md).
4. **Secret.** Add `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Optionally add a GitHub App for a named bot identity.
5. **Go.** Open an issue, add the label `state:ready`, watch Actions.

## Quick start: always-on runner

```bash
npm install -g @joyntshops/foundry
cd your-repo
foundry init          # config, labels, integration branch
foundry setup-bot     # GitHub App identity, two browser clicks
foundry run           # poll → claim → agent → verify → PR
```

## Commands

| Command | Mode | Description |
|---------|------|-------------|
| `foundry init` | both | Scaffold config, create labels, create `integration` branch |
| `foundry action` | Action | Run the state machine for one GitHub event (the Action's entry point) |
| `foundry run` | runner | Poll → claim → spawn agent sessions |
| `foundry serve` | runner | Webhook server with reconciliation polling |
| `foundry setup-bot` | runner | Create and install a GitHub App for Foundry |
| `foundry status` | runner | Active tasks, sessions, branches, PRs |
| `foundry sessions` | runner | Unified task dashboard |
| `foundry attach <issue>` | runner | Attach to an agent's tmux session |
| `foundry stop <issue>` | runner | Stop a session safely |
| `foundry reset [issue]` | runner | Tear down everything for a task and re-queue it |
| `foundry prune` | runner | Clean stale local state and worktrees |
| `foundry preview up/down/status <issue>` | runner | Manage a tracked task's preview environment by hand |
| `foundry review <pr>` | both | Rebase, merge into `integration`, rebuild |
| `foundry release <type>` | both | Unified version bump (patch/minor/major) |
| `foundry sync-integration` | both | Merge `main` into `integration` after a hotfix |

"Runner" commands act on the local state of an always-on runner and have no meaning inside an Actions job. See [CLI Reference](docs/foundry/cli-reference.md).

## Documentation

- [Overview](docs/foundry/overview.md)
- [GitHub Action](docs/foundry/github-action.md)
- [Installation](docs/foundry/installation.md)
- [Onboarding](docs/foundry/onboarding.md)
- [Workflows](docs/foundry/workflows.md)
- [Integration Strategy](docs/foundry/integration-strategy.md)
- [Preview Environments](docs/foundry/preview-environments.md)
- [Agent Backends](docs/foundry/agent-backends.md)
- [GitHub Backends](docs/foundry/github-backends.md)
- [CLI Reference](docs/foundry/cli-reference.md)
- [Configuration Reference](docs/foundry/config-reference.md)
- [Troubleshooting](docs/foundry/troubleshooting.md)

## Package

Published to GitHub Packages as `@joyntshops/foundry`. Merging to `main` publishes automatically. See [Installation](docs/foundry/installation.md) for registry authentication.

## License

MIT. See [LICENSE](LICENSE).
