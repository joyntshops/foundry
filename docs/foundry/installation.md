# Installation

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 8
- **git** ≥ 2.20
- **tmux** ≥ 3.0
- **GitHub CLI** (`gh`) — authenticated with repo access

## Install from GitHub Packages

### 1. Authenticate with GitHub Packages

Create or use an existing personal access token (PAT) with `read:packages` scope.

```bash
npm login --registry=https://npm.pkg.github.com --scope=@joynt
# Username: your-github-username
# Password: your-PAT
# Email: your-email
```

Or add to `~/.npmrc`:

```
@joynt:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_PAT
```

### 2. Install globally

```bash
npm install -g @joynt/foundry
```

### 3. Or use via npx

```bash
npx @joynt/foundry --help
```

## Verify Installation

```bash
foundry --version
foundry --help
```

## Upgrade

```bash
npm update -g @joynt/foundry
```

## Dependencies Check

Verify all required tools are available:

```bash
git --version      # ≥ 2.20
tmux -V            # ≥ 3.0
gh --version       # any recent version
gh auth status     # must be authenticated
```

## tmux

Foundry uses tmux for session management. Install if needed:

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux
```

Foundry works in macOS Terminal, iTerm2, VS Code terminal, and both bash and zsh.
