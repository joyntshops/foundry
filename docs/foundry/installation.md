# Installation

## Running Foundry

There is nothing to install on any machine. The workflow references `joyntshops/foundry@main` and the Action builds itself inside the job. The runner image has Node, git, and `gh`; the Action installs the Claude Code CLI.

You need the Foundry labels on the repo and a `.joynt-foundry.yml` at its root. `foundry init` creates both, which is the one reason to run the CLI once. Otherwise create the labels from the list in [Onboarding](onboarding.md) and copy [example.joynt-foundry.yml](../../example.joynt-foundry.yml).

Then continue with [GitHub Action](github-action.md).

## The CLI

The CLI is for setup (`init`, `setup-bot`), for operating on a task from any checkout (`reset`, `preview`), and for the integration branch (`review`, `release`, `sync-integration`). It needs Node ≥ 18, git, and `gh` authenticated via `gh auth login`.

### Authenticate with GitHub Packages

The package is published to GitHub Packages, which requires a token even for public packages.

1. Create a classic Personal Access Token at https://github.com/settings/tokens with the **`read:packages`** scope.
2. Log in to the registry:

```bash
npm login --registry=https://npm.pkg.github.com --scope=@joyntshops
# Username: your GitHub username
# Password: the token
```

### Install or run

```bash
npm install -g @joyntshops/foundry
foundry --version
```

Or without installing:

```bash
npx @joyntshops/foundry init
```

### Upgrade

```bash
npm update -g @joyntshops/foundry
```

Merges to `main` publish a new patch version automatically. The Action always uses whatever `@main` contains, so the CLI version and the Action can differ; nothing depends on them matching.
