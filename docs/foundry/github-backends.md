# GitHub Identity

How Foundry authenticates to GitHub, and which API client it uses. Two separate questions.

## Identity

### Under the Action: the job's token, or a GitHub App

A GitHub Actions job already has an identity. `${{ github.token }}` is scoped to the repo, carries the permissions the workflow grants, and dies with the job. The workflow template passes it to the Action, and that is enough for every call Foundry makes: labels, comments, PRs, pushes, `gh workflow run` for previews, deployment records.

The built-in token has one limit that matters: events it causes do not start other workflows. A GitHub App removes it and adds a name:

- **A named bot.** Comments, labels, and PRs appear as `<YourApp>[bot]` instead of `github-actions[bot]`.
- **Triggering other workflows.** Pushes and PRs made with the built-in token do not start `push` or `pull_request` workflows, so a repo's CI skips agent PRs and required checks can never pass; on some repos the run is created but held at "awaiting approval". Pushes and PRs made as an App trigger normally. This is why the App is part of setup rather than an option.

The workflow mints an App token when the `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY` secrets exist and falls back to the built-in token otherwise, so a repo can be wired before the App exists.

### Creating the App: `foundry setup-bot`

```bash
foundry setup-bot
```

Two browser clicks: GitHub's App manifest page, then the install page. Credentials land in `~/.joynt-foundry/github-app-{org}.json` and `.pem`. Copy the App ID and the `.pem` contents into the two secrets.

The manifest grants **issues, pull_requests, contents, checks: write** and **metadata: read**. Add **actions: write** (preview dispatch) and **deployments: write** (deployment records) in the App's settings afterwards, then **accept the permission update on the installation**. Changing the App only creates a request; installations keep the old set until an org owner accepts it. Check what jobs actually get:

```bash
gh api orgs/YOUR_ORG/installations --jq '.installations[] | select(.app_slug=="YOUR_APP") | .permissions'
```

That query needs org-owner rights; for anyone else it returns 403, and the only check left is a run. A `workflow_dispatch` of a no-op command (`-f command=stop` on an issue with no task) exercises the token mint and Foundry's own calls without starting an agent.

### For the CLI: resolution order

CLI commands (`reset`, `preview`, `review`, `release`, `init`) run on your machine and resolve credentials in this order:

1. `FOUNDRY_GITHUB_APP_ID` + `FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH` + `FOUNDRY_GITHUB_APP_INSTALLATION_ID` environment variables
2. Saved App credentials from `setup-bot` for the repo's org
3. `GITHUB_TOKEN` environment variable
4. `gh auth token`

With 3 or 4, actions appear as you.

Two name families, two purposes. `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY` are **repository secrets** read by the workflow template; `setup-bot` prints the `gh secret set` lines for them. `FOUNDRY_GITHUB_APP_ID`, `FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH`, and `FOUNDRY_GITHUB_APP_INSTALLATION_ID` are a **local override for the CLI** and apply to every org at once, so with several onboarded orgs do not export them; the per-org files from `setup-bot` are the mechanism that keeps them apart.

## API client

Foundry has two interchangeable GitHub clients behind one interface.

| Client | How it talks to GitHub | Notes |
|---|---|---|
| `octokit` (default) | `@octokit/rest` in-process | Required for App auth and for the Deployments API |
| `gh-cli` | Shells out to `gh` | Handy locally if `gh` is already logged in; no App auth, no deployments |

Selection, highest wins:

1. `--github-backend <client>` flag
2. `FOUNDRY_GITHUB_BACKEND` environment variable
3. `github_backend` in `.joynt-foundry.yml`
4. Default: `octokit`

The Action sets `FOUNDRY_GITHUB_BACKEND=octokit`.

## Permissions reference

| Call | Permission |
|---|---|
| Labels, issue comments, close issue | `issues: write` |
| Open PR, PR comments, close PR | `pull-requests: write` |
| Push branches, delete branches | `contents: write` |
| `gh workflow run` for preview up/down | `actions: write` |
| Deployment records for previews | `deployments: write` |
| Check run with verification results | `checks: write` (non-fatal warning without it) |

With the built-in token, grant these in the workflow's `permissions:` block. With an App, grant them on the App and accept on the installation. For a personal token used by the CLI, the classic `repo` scope covers all of them.

---

<details>
<summary>Manual GitHub App setup (instead of setup-bot)</summary>

1. Org settings → Developer settings → GitHub Apps → **New GitHub App**. For a personal repo, https://github.com/settings/apps.
2. Name it (globally unique), set any homepage URL, uncheck **Webhooks → Active**.
3. Repository permissions: Issues, Pull requests, Contents, Checks, Actions, Deployments: Read & Write. Metadata: Read.
4. Create. Note the **App ID**. Under Private keys, **Generate a private key** and download the `.pem`.
5. **Install App** → choose the org → **Only select repositories** → the repos Foundry manages. The installation ID is the last path segment of the resulting URL.
6. Add `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY` as secrets. For CLI use, save them locally:

```bash
cp downloaded.pem ~/.joynt-foundry/github-app-YOUR_ORG.pem && chmod 600 ~/.joynt-foundry/github-app-YOUR_ORG.pem
cat > ~/.joynt-foundry/github-app-YOUR_ORG.json <<'EOF'
{ "appId": 12345, "installationId": 67890, "slug": "your-app" }
EOF
```

</details>
