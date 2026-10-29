# Onboarding

Get a repo running on Foundry.

## 1. Initialize

```bash
cd your-repo
npx @joyntshops/foundry init
```

This creates `.joynt-foundry.yml` and the GitHub labels. It detects the project type (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and fills in `verify`, `integration_rebuild`, and `version_sources`. `--clean-labels` also removes labels that are not Foundry's.

It does **not** create a branch on that first run. The scaffold names `integration` as the integration branch; if the repo already integrates on another branch (`test`, `develop`), set `branches` first (step 2), then run `init` again. On that run it creates and pushes the configured branch only if it does not exist, making an initial commit first on an empty repo. The first repo onboarded with an existing `test` branch would otherwise have had an unwanted `integration` branch pushed in its name.

If you would rather not run the CLI, create these labels by hand and copy [example.joynt-foundry.yml](../../example.joynt-foundry.yml) to `.joynt-foundry.yml`:

| Label | Purpose |
|---|---|
| `state:in-progress` | Agent running |
| `state:waiting-for-input` | Agent asked a question; answer with `@foundry go <answer>` |
| `state:plan-review` | Agent posted a plan; approve with `@foundry go` |
| `state:ready-for-human-review` | PR is open |
| `state:failed` | Something went wrong; see the issue comments; `@foundry go` continues |
| `state:done` | PR merged, task complete |
| `mode:plan` / `mode:auto` / `mode:default` | Agent permission mode for this issue (set before `@foundry go`) |

The `state:*` labels are Foundry's status display; only Foundry sets them. Nothing happens when a human adds one.

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

# Every file that shares the unified version
version_sources:
  - package.json

# The agent
default_agent_backend: claude-code
agent_backends:
  claude-code:
    type: command
    preset: claude-code      # Foundry's maintained Claude Code command; see Agent Backends
    env:
      ANTHROPIC_MODEL: opus  # without this, the account's default model runs (Sonnet on a subscription)

# Preview environments (optional): a command or workflow you own
preview:
  mode: provider
  url_template: https://your-org.github.io/your-repo/previews/pr-{pr_number}/
  up_command:   gh workflow run preview-up.yml -f pr={pr_number} -f sha={sha} -f branch={branch}
  down_command: gh workflow run preview-down.yml -f pr={pr_number}
```

See [Configuration Reference](config-reference.md) for every key.

## 3. Add the workflow and the secrets

Add `.github/workflows/foundry.yml` from the template in [GitHub Action](github-action.md). Two facts about branches decide where it has to be:

- **Comment-triggered runs come from the default branch.** GitHub starts `issue_comment`, `schedule`, and `workflow_dispatch` workflows from the default branch's copy of the file, and the job checks that branch out, so `.joynt-foundry.yml` is read from there too. On a repo that promotes `test` to `main`, Foundry is inert until the workflow and config reach `main`; merging them to `test` early loses nothing.
- **Any branch can be exercised by dispatch.** `gh workflow run foundry.yml --ref <branch> -f issue=<n> -f command=go` runs that branch's workflow and reads that branch's config. This is how to test the setup, or a config change such as the model, before promotion.

Add the repository secret `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Set it so that no whitespace travels with it: `gh secret set NAME --repo OWNER/REPO --body "$(pbpaste | tr -d '[:space:]')"`, or redirect a file. A token pasted with a trailing newline fails every run with `401 Invalid bearer token`, and `gh secret set` waiting on an interactive prompt can hang in some terminals.

Run `foundry setup-bot` and add the two secrets it prints, `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY`. Treat the App as part of setup, not an option: a PR opened with the job's built-in token leaves this workflow's own `pull_request` run stuck at "awaiting approval", and the repo's other CI never runs on agent PRs. With the App, Foundry's comments and PRs carry its name and everything triggers normally.

Before spending agent time, prove the wiring with a no-op: `gh workflow run foundry.yml --ref <branch> -f issue=<any issue number> -f command=stop`. The run should mint the App token and log `has no task to stop`; nothing else happens.

Nothing runs anywhere until someone comments `@foundry go` on an issue.

## 4. Create a task

Open a GitHub Issue with a clear brief (the `Foundry task` issue template, written by `init`, has the shape that works) and comment `@foundry go`. Add the `mode:plan` label first if you want to approve a plan before any code is written. Anything else written on the issue before or after is given to the agent at its next launch; only `@foundry go` starts it.

## 5. Watch it

The job appears under Actions → Foundry. The job log is the agent transcript, and the transcript is uploaded as an artifact. On the issue, Foundry maintains a status comment and moves the `state:*` label.

## 6. Steer it

Comment on the issue:

| Comment | Effect |
|---|---|
| `@foundry go <message>` | Proceed from the branch with your message: answer a question, approve or revise a plan, send a PR back, resume a failed task |
| `@foundry restart` | Discard all work and start over |
| `@foundry stop` | Stop the agent; the branch stays |

Or submit a PR review with **Request changes**; the review is fed back to the agent. Only people with write access to the repo can command Foundry. Full details in [Workflows](workflows.md).

## 7. Stop or undo

`@foundry stop` cancels the running job (or press **Cancel** on the run in the Actions UI). `@foundry go` continues from the branch; `@foundry restart` starts over. To undo a task entirely from any checkout:

```bash
foundry reset 42 --force     # remove branch, PR, preview; @foundry go starts it again
```
