# Onboarding

Get a repository running on Foundry. Four steps; the agent runs nothing until the last one.

## 1. Scaffold

```bash
cd your-repo
npx @joynt/foundry init
```

This writes three files and creates the labels:

| File | What it is |
|---|---|
| `.joynt-foundry.yml` | Foundry's configuration. Project type is detected (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and `verify` is filled in. |
| `.github/workflows/foundry.yml` | The workflow, from [the shipped template](../../packages/foundry/templates/foundry.yml), with your production branch in its PR filter. Existing files are never overwritten. |
| `.github/ISSUE_TEMPLATE/foundry-task.md` | The issue template that gives the agent a developer-quality brief. |

Labels: `state:*` (Foundry's status display, set only by Foundry) and `mode:*` (settings a human puts on an issue). `--clean-labels` also removes labels that are not Foundry's. To do all of this by hand instead, copy [example.joynt-foundry.yml](../../example.joynt-foundry.yml) and the workflow template, and create the labels listed in [Workflows](workflows.md#labels-are-status-and-settings-never-commands).

`init` does **not** create a branch on the first run. The scaffold names `integration` as the integration branch; if the repo already integrates on another branch, set `branches` (next step) and run `init` again. Only then does it create and push the configured branch, and only if it is missing.

## 2. Configure

Edit `.joynt-foundry.yml`. The parts that matter most:

```yaml
repo: your-org/your-repo

# The branches you already have. Feature work is cut from and merged into
# `integration`; `production` is what it is promoted to. Rename nothing.
branches:
  integration: integration
  production: main

# Run in the worktree before any PR is opened. Fail-fast.
verify:
  - npm run lint
  - npm run typecheck
  - npm run build
  - npm test

# The agent
default_agent_backend: claude-code
agent_backends:
  claude-code:
    type: command
    preset: claude-code      # Foundry's maintained Claude Code command
    env:
      ANTHROPIC_MODEL: opus  # without this, the account's default model runs

# Preview environments (optional): a command or workflow you own
preview:
  mode: provider
  url_template: https://your-org.github.io/your-repo/previews/pr-{pr_number}/
  up_command:   gh workflow run preview-up.yml -f pr={pr_number} -f sha={sha} -f branch={branch}
  down_command: gh workflow run preview-down.yml -f pr={pr_number}
```

Choose `verify` from what already passes on the integration branch today; a command that fails there fails every task. See [Configuration](config-reference.md) for every key and [Preview Environments](preview-environments.md) when you are ready for previews.

## 3. Secrets

Two secrets, repository or organization level.

**`CLAUDE_CODE_OAUTH_TOKEN`**, from `claude setup-token`. Runs bill the Claude plan of the person who generated it. Set it so that no whitespace travels with it:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO --body "$(pbpaste | tr -d '[:space:]')"
```

A token pasted with a trailing newline fails every run with `401 Invalid bearer token`.

**A GitHub App identity.** Foundry acts as a GitHub App rather than with the job's built-in token, because pull requests opened with the built-in token do not trigger the repository's other workflows: agent PRs would get no CI and required checks could never pass. With an App, Foundry's comments and PRs carry its name and everything triggers normally. There are two ways to get one ([GitHub Identity](github-backends.md) has the details and the reasoning is in [the decision record](decisions/2026-11-03-public-app-token-broker.md)):

- **The public Foundry App (default).** [Install it](https://github.com/apps/joynt-foundry-bot-app/installations/new) on the repository. No key, no extra secrets: the workflow exchanges the job's OIDC token for an installation token at a broker run by joyntshops, scoped to this repository, and falls back to the job's built-in token with a warning on the run if the App is not installed.
- **A self-owned App (fallback).** Run `foundry setup-bot`; it creates an App in your organization in two browser clicks and prints the two `gh secret set` lines for `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY`. Choose this when your organization must not depend on a joyntshops endpoint. The manifest cannot request every permission Foundry needs, so finish in the App's settings as `setup-bot` prints.

## 4. Push, prove, go

Commit the three files and get them onto the **default branch**. GitHub starts `issue_comment`, `schedule`, and `workflow_dispatch` workflows from the default branch's copy of the file, and the job checks that branch out, so `.joynt-foundry.yml` is read from there too. On a repo that promotes `test` to `main`, Foundry is inert until the files reach `main`; merging them to `test` first loses nothing.

Before spending agent time, prove the wiring with a no-op. This works from any branch that has the files:

```bash
gh workflow run foundry.yml --repo OWNER/REPO --ref <branch> -f issue=1 -f command=stop
```

The run should obtain an App token (from the broker, or from your own App) and log `has no task to stop`. Nothing else happens.

Then open an issue with the **Foundry task** template ([how to write one](writing-a-task.md)) and comment `@foundry go`. Add the `mode:plan` label first to approve a plan before any code is written. The job appears under Actions → Foundry; its log is the agent's transcript. On the issue, Foundry keeps a status comment and moves the `state:*` label. From here, [Workflows](workflows.md) covers steering, stopping, and undoing a task.
