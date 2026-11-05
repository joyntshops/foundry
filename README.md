<p align="center">
  <img src="packages/foundry/assets/foundry-bot-256.png" width="128" alt="Foundry">
</p>

# Joynt Foundry

```
                             ▄▄█████▄▄
                          ▄█████████████▄
                         ▄███████████████▄
                     ▄▄▄▄█████████████████▄
                  ▄█████████████████████████▄▄▄
                ▄███████████████████████████████▄
                ██████████████████████████████████
                ██████████████████████████████████
                ██████████████████████████████████
      ▄▄▄▄▄▄▄▄▄▄▄████████████████████████████████▄▄▄▄▄▄▄
      ██████████████████████████████████████████████████
      █████████████████████▀▀▀▀▀▀▀▀█████████████████████
      ██████████████████▀▒▒▒▒▒▒▒▒▒▒▒▒▀██████████████████
      ████████████████▀▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▀████████████████
      ███████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒███████████████
      ██████████████▒▒▒▒▒▒▒▒▒▒░░▒▒▒▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒▒▒    ▒▒▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒▒      ▒▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒░      ░▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒        ▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒        ▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒        ▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒        ▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒▒      ▒▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒▒▒    ▒▒▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒▒▒▒░░▒▒▒▒▒▒▒▒▒▒██████████████
      ██████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████████████

      issue ──▶ agent ──▶ verify ──▶ pull request
```

Foundry turns a GitHub Issue into a verified pull request. Comment `@foundry go` on an issue and Foundry claims it, runs a coding agent in an isolated git worktree, runs your verify commands, opens a PR into your integration branch, and stands up a preview if you have one. Humans review on GitHub. Three comments are the whole control surface: `@foundry go`, `@foundry restart`, `@foundry stop`. Every other comment is context the agent reads; labels show status.

Foundry is a **GitHub Action**. There is no server to run and no machine to keep awake; the one hosted piece, a token broker that lets every repository use the same public GitHub App, is optional ([GitHub identity](docs/foundry/github-backends.md)). Each GitHub event that matters starts a job, the job performs one transition of the task's state machine, and state lives on GitHub: in labels, a structured claim comment, the PR, and the preview comment.

Foundry is the orchestration layer, not the agent. It runs Claude Code, aider, or any CLI you configure, and bills your own Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN`.

## Quick start

1. **Scaffold.** From a clone, run `npx @joynt/foundry init`. It writes `.joynt-foundry.yml`, `.github/workflows/foundry.yml`, and an issue template, and creates the `state:*` and `mode:*` labels. Set `branches:` to the branches you already deploy from; nothing is renamed.
2. **Identity.** Add `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` and [install the Foundry App](https://github.com/apps/joynt-foundry/installations/new) on the repository. That is the whole identity setup: no App of your own, no key. (An organization that must not depend on an outside endpoint runs `foundry setup-bot` instead; [Onboarding](docs/foundry/onboarding.md#3-identity) has both.)
3. **Push** to the default branch. Foundry listens from there.
4. **Go.** Open an issue, comment `@foundry go`, watch Actions → Foundry.

The full walkthrough is in [Onboarding](docs/foundry/onboarding.md).

## The loop

```
human comments @foundry go on an issue
  → claim (state:in-progress + claim comment)
  → worktree from origin/<integration branch>
  → agent runs; transcript is the job log
  → the agent's typed report: done · needs input · plan ready · blocked
  → verify (lint, typecheck, build, test); no PR until green
  → PR into integration · state:ready-for-human-review · preview up
human reviews; @foundry go <feedback> or "request changes" sends the agent back to the branch
approve → Foundry rebases, waits for checks, merges → state:done · preview down
```

## Documentation

Start here:

- [Overview](docs/foundry/overview.md): what Foundry does, what it does not, and the security model
- [Onboarding](docs/foundry/onboarding.md): get a repo running
- [Writing a task](docs/foundry/writing-a-task.md): what the agent sees and how to brief it
- [Workflows](docs/foundry/workflows.md): the three commands and how to steer a task

Reference:

- [Configuration](docs/foundry/config-reference.md) · [CLI](docs/foundry/cli-reference.md) · [GitHub Action](docs/foundry/github-action.md)
- [Agent backends](docs/foundry/agent-backends.md) · [Preview environments](docs/foundry/preview-environments.md) · [GitHub identity](docs/foundry/github-backends.md) · [Integration branch](docs/foundry/integration-strategy.md)
- [Troubleshooting](docs/foundry/troubleshooting.md) · [Foundry and `claude-code-action`](docs/foundry/comparison.md)

See it working: the [demo repository](https://github.com/joyntshops/foundry-demo) is public, with real issues, agent PRs, runs and previews.

## Package

The CLI is published to npmjs.com as [`@joynt/foundry`](https://www.npmjs.com/package/@joynt/foundry) and is only needed for setup and for operating on a task from a checkout; the Action builds itself inside the job. See [Installation](docs/foundry/installation.md).

## Project

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Maintainer documentation](docs/foundry/maintainers/README.md)

## License

MIT. See [LICENSE](LICENSE).
