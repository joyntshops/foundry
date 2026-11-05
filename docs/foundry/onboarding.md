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

## 3. Identity

Two things, and the second is one click.

**The Claude token.** Add the secret `CLAUDE_CODE_OAUTH_TOKEN`, repository or organization level, from `claude setup-token`. Runs bill the Claude plan of the person who generated it. Set it so that no whitespace travels with it:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO --body "$(pbpaste | tr -d '[:space:]')"
```

A token pasted with a trailing newline fails every run with `401 Invalid bearer token`.

**The Foundry App.** [Install it on the repository](https://github.com/apps/joynt-foundry/installations/new). Pick the repository (or the whole organization) on GitHub's install page and confirm. That is all: no key to download, no further secrets. Foundry's comments, PRs and commits then appear as `joynt-foundry[bot]`, and because the PRs are opened by an App rather than by the job's built-in token, the repository's own CI runs on them and required checks can pass. Under the hood the workflow trades the job's OIDC token for an App token scoped to this one repository at a broker that joyntshops runs; the App's private key never leaves that broker ([why it is built this way](decisions/2026-11-03-public-app-token-broker.md)).

<details>
<summary><b>Fallback: an App your organization owns</b></summary>

Choose this only when your organization must not depend on a joyntshops endpoint, or to keep running while the broker is unavailable. It replaces the install step above; do not do both.

```bash
foundry setup-bot
```

Two browser clicks create an App in your organization with every permission Foundry needs and install it. The command then prints two `gh secret set` lines for `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY`; run them. The workflow uses those secrets whenever they exist and never calls the broker. If GitHub grants fewer permissions than requested, `setup-bot` lists the missing ones with the settings URL to add them at; accept the permission update on the installation afterwards. [GitHub Identity](github-backends.md) has the details.

</details>

With neither the App installed nor the secrets set, the workflow still runs with the job's built-in token and warns on every run: the agent's PRs then get no CI, and on an organization with GitHub's default Actions settings the PR cannot be opened at all (the task ends `state:failed` with its branch pushed; install the App and `@foundry go` resumes it).

## 4. Push, prove, go

Commit the three files and get them onto the **default branch**. GitHub starts `issue_comment`, `schedule`, and `workflow_dispatch` workflows from the default branch's copy of the file, and the job checks that branch out, so `.joynt-foundry.yml` is read from there too. On a repo that promotes `test` to `main`, Foundry is inert until the files reach `main`; merging them to `test` first loses nothing.

Before spending agent time, prove the wiring with a no-op. This works from any branch that has the files:

```bash
gh workflow run foundry.yml --repo OWNER/REPO --ref <branch> -f issue=1 -f command=stop
```

The run should log `has no task to stop` and nothing else happens. In its log, the step **Token from the Foundry broker** shows the exchange succeeding (with the fallback App it is skipped and **Mint GitHub App token** runs instead). A warning titled *Foundry broker* on that step means the App is not installed on this repository or the exchange failed; the run still completes on the built-in token, so fix the install before the first real task.

Then open an issue with the **Foundry task** template ([how to write one](writing-a-task.md)) and comment `@foundry go`. Add the `mode:plan` label first to approve a plan before any code is written. The job appears under Actions → Foundry; its log is the agent's transcript. On the issue, Foundry keeps a status comment and moves the `state:*` label. From here, [Workflows](workflows.md) covers steering, stopping, and undoing a task.
