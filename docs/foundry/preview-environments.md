# Preview Environments

## Overview

Foundry is **not** a hosting provider. It orchestrates the preview lifecycle -- creating, commenting, and tearing down -- while a configured external command (Vercel, Netlify, a custom script, etc.) handles the actual deployment. When no `preview` section is present in `.joynt-foundry.yml`, all preview logic is skipped entirely.

## Configuration

Two optional config sections control preview behavior:

```yaml
# ── Preview ─────────────────────────────────────────────────────────────
preview:
  mode: "template"                        # "template" or "provider"
  url_template: "https://pr-{issue}.preview.example.com"
  comment: true                           # post/update a PR comment with the URL (default true)

# ── GitHub Deployments (optional) ───────────────────────────────────────
github_deployments:
  enabled: true
  environment: "preview"                  # GitHub environment name (default "preview")
  production: false                       # mark as production environment (default false)
  auto_inactive: true                     # auto-deactivate old deployments (default true)
```

Both sections are optional. When `preview` is absent, Foundry never runs deploy commands, never posts preview comments, and never creates deployment records.

## Template Mode

Use template mode when the preview URL is deterministic (e.g. a wildcard DNS entry or a CDN that maps branch names to subdomains). No external command is executed.

```yaml
preview:
  mode: "template"
  url_template: "https://pr-{issue}.preview.example.com"
```

Foundry expands the template and posts the resulting URL as a PR comment. No deploy command is run -- the hosting platform is expected to pick up the branch automatically (e.g. via a GitHub webhook or branch-deploy rule).

## Provider Mode

Use provider mode when a command must be executed to trigger the deploy.

```yaml
preview:
  mode: "provider"
  url_template: "https://pr-{issue}.preview.example.com"
  up_command: "./scripts/deploy-preview.sh {issue} {branch}"
  down_command: "./scripts/teardown-preview.sh {issue} {branch}"
```

When `url_template` is also set, the URL always comes from the template and the command's output is ignored. This is the common case: the command deploys, the URL is predictable. It also matters for commands like `gh workflow run`, which print an Actions run URL that is a URL but not the preview.

If `url_template` is **not** set, the command must print the URL to stdout as either:
- A **plain URL** (`https://...`) -- the last line starting with `http://` or `https://` is used.
- A **JSON object** with a `url` field -- `{ "url": "https://my-preview.vercel.app" }`.

### Vercel example (URL from command output)

```yaml
preview:
  mode: "provider"
  up_command: "vercel deploy --prebuilt --yes 2>/dev/null"
  down_command: "vercel rm {branch} --yes 2>/dev/null"
```

### Custom script example (URL from template)

```yaml
preview:
  mode: "provider"
  url_template: "https://pr-{issue}.staging.example.com"
  up_command: "./scripts/deploy-preview.sh {issue}"
  down_command: "./scripts/teardown-preview.sh {issue}"
```

The script receives template variables both as interpolated arguments and as environment variables (see below).

## Template Variables

The following variables are expanded in `url_template`, `up_command`, and `down_command`:

| Variable | Description | Env var equivalent |
|----------|-------------|--------------------|
| `{branch}` | Feature branch name | `FOUNDRY_BRANCH` |
| `{issue}` | Issue number | `FOUNDRY_ISSUE` |
| `{repo}` | Repository in `owner/repo` format | `FOUNDRY_REPO` |
| `{pr_number}` | Pull request number (empty if PR not yet created) | `FOUNDRY_PR_NUMBER` |
| `{sha}` | HEAD commit SHA of the worktree | `FOUNDRY_SHA` |

All five environment variables are set in the command's environment automatically, so scripts can read them without relying on string interpolation.

## GitHub Deployments Integration

When `github_deployments.enabled` is `true`, Foundry creates a GitHub Deployment record each time a preview goes live. This makes previews visible in the repo's **Settings > Environments** UI and in the PR's deployment status section.

```yaml
github_deployments:
  enabled: true
  environment: "preview"       # name shown in the Environments UI
  production: false            # true marks this as the production environment
  auto_inactive: true          # auto-deactivate previous deployments for the same env
```

Lifecycle:
1. On **preview up**, Foundry creates a Deployment with status `success` and the preview URL as the environment URL.
2. On **preview down**, Foundry sets the deployment status to `inactive`.

Deployment API calls are best-effort -- failures are logged as warnings and never block the pipeline. The Deployments API requires Octokit (there is no `gh` CLI equivalent), so `github_backend: "gh-cli"` does not affect deployment creation.

## CLI Commands

### `foundry preview up <issue>`

Trigger the preview deployment for a tracked task.

```bash
foundry preview up 42
```

Resolves the URL (via template or provider command), saves it to task state, creates a GitHub Deployment (if enabled), and posts/updates the PR comment.

### `foundry preview down <issue>`

Tear down the preview environment.

```bash
foundry preview down 42
```

Runs the `down_command` (provider mode only), sets the GitHub Deployment status to `inactive`, and updates the PR comment to show the URL as struck through.

### `foundry preview status <issue>`

Show the current preview state for a task.

```bash
foundry preview status 42
```

Displays the preview URL, GitHub Deployment ID, and state (`active`, `inactive`, or `none`).

## Automatic Lifecycle

Previews are managed automatically by whichever mode is running Foundry (the Action or `foundry run` / `foundry serve`):

| Event | Action |
|-------|--------|
| PR created or updated (push to existing PR) | `previewUp` -- deploy and post comment |
| PR merged | `previewDown` -- tear down and mark inactive |
| `@foundry stop` / `@foundry restart` / `@foundry start` | `previewDown` -- tear down before stopping or restarting |
| `foundry reset` | `previewDown` -- tear down as part of full cleanup |

No manual `foundry preview up/down` calls are needed during normal operation. The CLI subcommands exist for debugging and one-off use.

## Manual Test Checklist

Use this list to verify preview environments are working end-to-end:

1. **Config loads** -- Add a `preview` section to `.joynt-foundry.yml` and run `foundry preview status 42`. It should print `State: none` (no deploy yet, but no config error).
2. **Template mode resolves** -- Set `mode: "template"` with a `url_template`. Run `foundry preview up <issue>`. Confirm the expanded URL appears in task state and as a PR comment.
3. **Provider mode executes** -- Set `mode: "provider"` with an `up_command` that echoes a URL. Run `foundry preview up <issue>`. Confirm the URL from stdout is captured.
4. **PR comment upsert** -- Run `preview up` twice. Confirm a single comment is updated, not duplicated.
5. **Preview down** -- Run `foundry preview down <issue>`. Confirm the PR comment shows the URL struck through and state is `inactive`.
6. **GitHub Deployment** -- Enable `github_deployments`, run `preview up`, and check the repo's Environments page on GitHub for a `preview` environment with the correct URL.
7. **Automatic up on PR creation** -- Let the runner create a PR for a ready issue. Confirm the preview comment appears automatically.
8. **Automatic down on merge** -- Merge the PR. Confirm the preview is torn down and the deployment status is set to `inactive`.
9. **Automatic down on reset** -- Run `foundry reset <issue> --force` while a preview is active. Confirm teardown runs.
10. **No-op when unconfigured** -- Remove the `preview` section entirely. Confirm no preview commands run and no errors are logged.
