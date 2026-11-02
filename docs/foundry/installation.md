# Installation

## Running Foundry

There is nothing to install on any machine. The workflow references the `joyntshops/foundry` action and the Action builds itself inside the job. The runner image has Node, git, and `gh`; the Action installs the Claude Code CLI.

You need the Foundry labels on the repo, a `.joynt-foundry.yml` at its root, and the workflow file. `foundry init` creates all three, which is the one reason to run the CLI once. Otherwise create the labels from the list in [Workflows](workflows.md#labels-are-status-and-settings-never-commands), copy [example.joynt-foundry.yml](../../example.joynt-foundry.yml), and copy [the workflow template](../../packages/foundry/templates/foundry.yml) to `.github/workflows/foundry.yml`.

Then continue with [Onboarding](onboarding.md).

## The CLI

The CLI is for setup (`init`, `setup-bot`), for operating on a task from any checkout (`reset`, `preview`), and for the integration branch (`review`, `release`, `sync-integration`). It needs Node ≥ 18, git, and `gh` authenticated via `gh auth login`.

The package is `@joynt/foundry` on [npmjs.com](https://www.npmjs.com/package/@joynt/foundry). It is public; no registry login is needed. (The npm scope is `@joynt`; the GitHub organization is `joyntshops`.)

### Run without installing

```bash
npx @joynt/foundry init
```

### Install

```bash
npm install -g @joynt/foundry
foundry --version
```

### Upgrade

```bash
npm update -g @joynt/foundry
```

Merges to `main` publish a new patch version automatically ([Releasing](releasing.md)). The CLI version and the Action ref a workflow pins can differ; nothing depends on them matching.

### If you installed from GitHub Packages before November 2026

Versions up to 0.1.51 were published to GitHub Packages as `@joyntshops/foundry`, which required a token to install. That copy is frozen and will not receive new versions; releases now go to npmjs.com under the new name. Replace the global install:

```bash
npm uninstall -g @joyntshops/foundry
npm install -g @joynt/foundry
```

A `@joyntshops:registry=https://npm.pkg.github.com/` line in `~/.npmrc` does not affect the new scope and can be removed.
