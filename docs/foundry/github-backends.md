# GitHub Backends

Foundry supports two GitHub API backends. Choose based on your environment.

There are two separate concerns:

1. **Which backend** to use (`gh-cli` or `octokit`) — controlled by `FOUNDRY_GITHUB_BACKEND`
2. **Authentication** — how the chosen backend authenticates with GitHub

## Choosing a Backend

| Backend | Best for | Auth method |
|---------|----------|-------------|
| `gh-cli` (default) | Local development | `gh auth login` (handled by the CLI) |
| `octokit` | CI/containers, performance | `GITHUB_TOKEN` env var or `gh auth token` fallback |

### Setting the backend

Priority order (highest wins):

1. `--github-backend <backend>` CLI flag
2. `FOUNDRY_GITHUB_BACKEND` environment variable — values: `gh-cli` or `octokit`
3. `github_backend` field in `.joynt-foundry.yml`
4. Default: `gh-cli`

Examples:

```yaml
# .joynt-foundry.yml
github_backend: "octokit"
```

```bash
# Environment variable
export FOUNDRY_GITHUB_BACKEND=octokit

# CLI flag
foundry run --github-backend octokit
```

## Authentication

### `gh-cli` backend

No token config needed. Uses whatever `gh auth login` has configured.

### `octokit` backend

Requires a GitHub token. Resolution order:

1. `GITHUB_TOKEN` environment variable (recommended for CI/containers)
2. Falls back to running `gh auth token` to extract the token from the GitHub CLI

```bash
# Option 1: explicit token (CI)
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Option 2: reuse gh CLI auth (local dev)
gh auth login   # octokit will call `gh auth token` automatically
```

## Required Token Permissions

These apply to both backends (the `gh` CLI uses a token under the hood too).

### Classic PAT
- `repo` scope

### Fine-grained PAT
- **Issues**: Read & Write
- **Pull requests**: Read & Write
- **Metadata**: Read (auto-included)

## Token Lifecycle

The token is resolved once at startup. If it expires mid-session:
- API calls will log errors
- The runner retries on the next poll cycle
- Restart the runner to re-resolve the token
