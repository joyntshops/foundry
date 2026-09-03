# Installation

## If you use the GitHub Action

There is nothing to install on any machine. The workflow references `joyntshops/foundry@main` and the Action builds itself inside the job. The runner image already has Node, git, and `gh`; the Action installs the Claude Code CLI.

You still need the Foundry labels on the repo and a `.joynt-foundry.yml` at its root. `foundry init` creates both, which means running the CLI once from a clone. Either install it as below, or create the labels by hand from the list in [Onboarding](onboarding.md) and copy [example.joynt-foundry.yml](../../example.joynt-foundry.yml).

Then continue with [GitHub Action](github-action.md).

## If you run the always-on runner

### Prerequisites

- **Node.js** ≥ 18 and **npm** ≥ 8
- **git** ≥ 2.20
- **tmux** ≥ 3.0 (the runner executes agents in tmux sessions)
- **GitHub CLI** (`gh`), authenticated via `gh auth login`
- **SSH keys** or HTTPS credentials for pushing to GitHub

```bash
# macOS
brew install tmux gh

# Ubuntu/Debian
sudo apt install tmux gh
```

### Authenticate with GitHub Packages

The package is published to GitHub Packages, which requires a token even for public packages.

1. Create a classic Personal Access Token at https://github.com/settings/tokens with the **`read:packages`** scope.
2. Log in to the registry:

```bash
npm login --registry=https://npm.pkg.github.com --scope=@joyntshops
# Username: your GitHub username
# Password: the token
```

### Install

```bash
npm install -g @joyntshops/foundry
foundry --version
```

Or without installing:

```bash
npx @joyntshops/foundry --help
```

### Upgrade

```bash
npm update -g @joyntshops/foundry
```

Merges to `main` publish a new patch version automatically.

### Check dependencies

```bash
git --version      # ≥ 2.20
tmux -V            # ≥ 3.0
gh auth status     # must be authenticated
```

Foundry works in macOS Terminal, iTerm2, the VS Code terminal, and under bash or zsh.
