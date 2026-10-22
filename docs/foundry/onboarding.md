# Onboarding

Get a repo running on Foundry.

## 1. Initialize

```bash
cd your-repo
npx @joyntshops/foundry init
```

This creates `.joynt-foundry.yml`, creates the GitHub labels, and creates and pushes the `integration` branch. It detects the project type (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and fills in `verify`, `integration_rebuild`, and `version_sources`. If the repo has no commits yet, it makes an initial one so the branch can exist. `--clean-labels` also removes labels that are not Foundry's.

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

# Preview environments (optional): a command or workflow you own
preview:
  mode: provider
  url_template: https://your-org.github.io/your-repo/previews/pr-{pr_number}/
  up_command:   gh workflow run preview-up.yml -f pr={pr_number} -f sha={sha} -f branch={branch}
  down_command: gh workflow run preview-down.yml -f pr={pr_number}
```

See [Configuration Reference](config-reference.md) for every key.

## 3. Add the workflow and the secret

Add `.github/workflows/foundry.yml` from the template in [GitHub Action](github-action.md) and commit it to the default branch; issue events only fire from there. Add the repository secret `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

Optionally run `foundry setup-bot` to create a GitHub App and add its ID and private key as secrets. With them, Foundry's comments and PRs carry the App's name and its pushes trigger your other workflows. Without them, the job's built-in token is used and everything still works.

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
