# GitHub Backends

Foundry supports two GitHub API backends. Choose based on your environment.

There are two separate concerns:

1. **Which backend** to use (`gh-cli` or `octokit`) — controlled by `FOUNDRY_GITHUB_BACKEND`
2. **Authentication** — how the chosen backend authenticates with GitHub

## Quick Start — Recommended: `foundry setup-bot`

The fastest way to authenticate Foundry is with a GitHub App. One command, two browser clicks:

```bash
foundry setup-bot
```

This:
- Creates a **GitHub App** scoped to your org with the right permissions
- Installs it on your repos
- Saves credentials locally (`~/.joynt-foundry/github-app-{org}.*`)
- Auto-selects the `octokit` backend — no config changes needed

After setup, `foundry run` authenticates automatically. Actions appear as `Foundry Bot[bot]` with a distinct identity — not your personal account.

**No `gh auth login`, no `GITHUB_TOKEN`, no env vars needed for local dev.**

## Choosing a Backend

| Backend | Best for | Auth method |
|---------|----------|-------------|
| `octokit` (recommended) | All environments — auto-selected after `setup-bot` | GitHub App (auto-managed tokens) |
| `gh-cli` | Quick start without `setup-bot` | `gh auth login` (personal account) |

### Setting the backend

Priority order (highest wins):

1. `--github-backend <backend>` CLI flag
2. `FOUNDRY_GITHUB_BACKEND` environment variable — values: `gh-cli` or `octokit`
3. `github_backend` field in `.joynt-foundry.yml`
4. Auto-detect: if GitHub App credentials exist for the current org → `octokit`
5. Default: `gh-cli`

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

### GitHub App auth (recommended)

After running `foundry setup-bot`, credentials are stored per-org:

- `~/.joynt-foundry/github-app-{org}.json` — App ID, installation ID, slug
- `~/.joynt-foundry/github-app-{org}.pem` — private key (mode `0600`)

The `octokit` backend uses `@octokit/auth-app` to generate short-lived installation tokens from these credentials. Tokens are auto-refreshed — no manual management.

**Auth resolution order** (octokit backend):

1. **Env vars** (CI): `FOUNDRY_GITHUB_APP_ID` + `FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH` + `FOUNDRY_GITHUB_APP_INSTALLATION_ID`
2. **Saved credentials**: `~/.joynt-foundry/github-app-{org}.*` (after `setup-bot`)
3. **Personal token fallback**: `GITHUB_TOKEN` env var
4. **gh CLI fallback**: `gh auth token`

### CI configuration

For CI environments, set three env vars instead of running `setup-bot`:

```bash
export FOUNDRY_GITHUB_APP_ID=12345
export FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH=/path/to/key.pem
export FOUNDRY_GITHUB_APP_INSTALLATION_ID=67890
```

These take precedence over saved credentials.

### Personal token fallback

If no GitHub App is configured, the `octokit` backend falls back to personal tokens:

```bash
# Option 1: explicit token
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Option 2: reuse gh CLI auth
gh auth login   # octokit will call `gh auth token` automatically
```

### `gh-cli` backend

No token config needed. Uses whatever `gh auth login` has configured. Actions appear as the `gh`-authenticated user.

## Required Permissions

### GitHub App (via `setup-bot`)

`setup-bot` requests these automatically:
- **Issues**: Read & Write
- **Pull requests**: Read & Write
- **Contents**: Read & Write
- **Metadata**: Read

### Personal token (fallback)

**Classic PAT:**
- `repo` scope

**Fine-grained PAT:**
- **Issues**: Read & Write
- **Pull requests**: Read & Write
- **Metadata**: Read (auto-included)

## Token Lifecycle

**GitHub App tokens** (recommended): Managed automatically by `@octokit/auth-app`. JWTs are generated from the private key, exchanged for short-lived installation tokens, and refreshed transparently.

**Personal tokens**: Resolved once at startup. If a token expires mid-session:
- API calls will log errors
- The runner retries on the next poll cycle
- Restart the runner to re-resolve the token

---

<details>
<summary>Advanced: manual GitHub App setup</summary>

If you prefer to create the GitHub App manually instead of using `foundry setup-bot`:

### Step 1: Create the App

1. Go to your **GitHub org's** settings: `https://github.com/organizations/YOUR_ORG/settings/apps`
   - For a personal repo (no org), go to: `https://github.com/settings/apps`
2. Click **New GitHub App**
3. Fill in:
   - **Name**: e.g., `Foundry Bot` (must be globally unique on GitHub)
   - **Homepage URL**: anything (e.g., your repo URL)
   - **Webhooks**: uncheck **"Active"** — Foundry polls, it doesn't need webhooks
4. Under **Permissions → Repository permissions**, grant:
   - **Issues**: Read & Write
   - **Pull requests**: Read & Write
   - **Contents**: Read & Write (for branch operations)
   - **Metadata**: Read (auto-selected)
5. Click **Create GitHub App**
6. On the next page, note the **App ID** (a number near the top)
7. Scroll to **Private keys** → click **Generate a private key**
   - This downloads a `.pem` file

### Step 2: Install the App on Your Repo

1. From the App's settings page, click **Install App** in the left sidebar
2. Choose the org (or your personal account) that owns the repo
3. Select **"Only select repositories"** → pick the repo Foundry manages
4. Click **Install**
5. After installation, note the **Installation ID** from the URL:
   `https://github.com/organizations/YOUR_ORG/settings/installations/INSTALLATION_ID`

### Step 3: Save credentials manually

Create the credential files in `~/.joynt-foundry/`:

```bash
# Save the private key (ensure secure permissions)
cp /path/to/downloaded.pem ~/.joynt-foundry/github-app-YOUR_ORG.pem
chmod 600 ~/.joynt-foundry/github-app-YOUR_ORG.pem

# Create the metadata file
cat > ~/.joynt-foundry/github-app-YOUR_ORG.json << 'EOF'
{
  "appId": 12345,
  "installationId": 67890,
  "slug": "foundry-bot"
}
EOF
```

Or set env vars for CI:

```bash
export FOUNDRY_GITHUB_APP_ID=12345
export FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH=/path/to/your-app.private-key.pem
export FOUNDRY_GITHUB_APP_INSTALLATION_ID=67890
```

</details>
