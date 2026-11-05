<p align="center">
  <img src="https://raw.githubusercontent.com/joyntshops/foundry/main/packages/foundry/assets/foundry-bot-256.png" width="128" alt="Foundry">
</p>

# Joynt Foundry

Foundry turns a GitHub Issue into a verified pull request. Comment `@foundry go` on an issue and Foundry claims it, runs a coding agent in an isolated git worktree, runs your verify commands, opens a PR into your integration branch, and stands up a preview if you have one. Humans review on GitHub. Three comments are the whole control surface: `@foundry go`, `@foundry restart`, `@foundry stop`. Every other comment is context the agent reads; labels show status.

Foundry is a **GitHub Action**. There is no server to run and no machine to keep awake. Each GitHub event that matters starts a job, the job performs one transition of the task's state machine, and state lives on GitHub: in labels, a structured claim comment, the PR, and the preview comment.

Foundry is the orchestration layer, not the agent. It runs Claude Code, aider, or any CLI you configure, and bills your own Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN`.

## What this package is for

This package is the Foundry CLI. The Action itself is referenced from your workflow as `joyntshops/foundry@v0` and builds inside the job, so nothing needs to be installed to run Foundry. The CLI is for:

- **Setup**: `init` scaffolds a repository; `setup-bot` creates a self-owned GitHub App for organizations that do not use the public one.
- **Operating on a task** from any checkout: `reset`, `preview up` / `down` / `status`.
- **The integration branch**: `review`, `release`, `sync-integration`.

It needs Node 18 or later, git, and `gh` authenticated with `gh auth login`.

## Quick start

```bash
npx @joynt/foundry init
```

1. **Scaffold.** From a clone, `init` writes `.joynt-foundry.yml`, `.github/workflows/foundry.yml`, and an issue template, and creates the `state:*` and `mode:*` labels. Set `branches:` to the branches you already deploy from; nothing is renamed.
2. **Identity.** Add `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` and [install the Foundry App](https://github.com/apps/joynt-foundry/installations/new) on the repository. No App of your own, no key; an organization that must not depend on an outside endpoint runs `npx @joynt/foundry setup-bot` instead.
3. **Push** to the default branch. Foundry listens from there.
4. **Go.** Open an issue, comment `@foundry go`, and watch Actions → Foundry.

The full walkthrough is in [Onboarding](https://github.com/joyntshops/foundry/blob/main/docs/foundry/onboarding.md).

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

## Install globally

```bash
npm install -g @joynt/foundry
foundry --version
```

The CLI version and the Action ref a workflow pins can differ; nothing depends on them matching.

## Documentation

- [Overview](https://github.com/joyntshops/foundry/blob/main/docs/foundry/overview.md): what Foundry does, what it does not, and the security model
- [Installation](https://github.com/joyntshops/foundry/blob/main/docs/foundry/installation.md) · [Onboarding](https://github.com/joyntshops/foundry/blob/main/docs/foundry/onboarding.md)
- [Writing a task](https://github.com/joyntshops/foundry/blob/main/docs/foundry/writing-a-task.md) · [Workflows](https://github.com/joyntshops/foundry/blob/main/docs/foundry/workflows.md)
- [Configuration](https://github.com/joyntshops/foundry/blob/main/docs/foundry/config-reference.md) · [CLI](https://github.com/joyntshops/foundry/blob/main/docs/foundry/cli-reference.md) · [GitHub Action](https://github.com/joyntshops/foundry/blob/main/docs/foundry/github-action.md)
- [Agent backends](https://github.com/joyntshops/foundry/blob/main/docs/foundry/agent-backends.md) · [Preview environments](https://github.com/joyntshops/foundry/blob/main/docs/foundry/preview-environments.md) · [GitHub identity](https://github.com/joyntshops/foundry/blob/main/docs/foundry/github-backends.md) · [Troubleshooting](https://github.com/joyntshops/foundry/blob/main/docs/foundry/troubleshooting.md)

A public demo of a repository wired up end to end: [joyntshops/foundry-demo](https://github.com/joyntshops/foundry-demo).

Source, issues, and contributing: [github.com/joyntshops/foundry](https://github.com/joyntshops/foundry).

## License

MIT.
