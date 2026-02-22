# Installation

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 8
- **git** ≥ 2.20
- **tmux** ≥ 3.0
- **GitHub CLI** (`gh`) — authenticated via `gh auth login`
- **SSH keys** configured for GitHub access

## Install from GitHub Packages

### 1. Create a GitHub Personal Access Token

1. Go to **GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)**
   — direct link: https://github.com/settings/tokens
2. Click **"Generate new token (classic)"**
3. Give it a name (e.g., `foundry-packages`)
4. Select the **`read:packages`** scope
5. Click **Generate token** and copy it immediately — you won't see it again

### 2. Authenticate with GitHub Packages

```bash
npm login --registry=https://npm.pkg.github.com --scope=@joyntshops
# Username: your-github-username
# Password: <paste your token>
```

### 3. Install globally

```bash
npm install -g @joyntshops/foundry
```

### 4. Or use via npx

```bash
npx @joyntshops/foundry --help
```

## Verify Installation

```bash
foundry --version
foundry --help
```

## Upgrade

```bash
npm update -g @joyntshops/foundry
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
