# Onboarding

Get a repo running on Foundry. Steps 1 and 2 are the same for both modes; step 3 is where they differ.

## 1. Initialize

```bash
cd your-repo
foundry init
```

This creates `.joynt-foundry.yml`, creates the GitHub labels, and creates and pushes the `integration` branch. It detects the project type (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and fills in `verify`, `integration_rebuild`, and `version_sources`. If the repo has no commits yet, it makes an initial one so the branch can exist.

`foundry init --clean-labels` also removes labels that are not Foundry's.

If you would rather not install the CLI, create these labels by hand and copy [example.joynt-foundry.yml](../../example.joynt-foundry.yml) to `.joynt-foundry.yml`:

| Label | Purpose |
|---|---|
| `state:ready` | Task ready for Foundry to claim |
| `state:in-progress` | Task claimed; agent running or about to |
| `state:waiting-for-input` | Agent asked a question; reply on the issue |
| `state:plan-review` | Agent posted a plan; approve with `@foundry continue` |
| `state:ready-for-human-review` | PR is open |
| `state:failed` | Something went wrong; see the issue comments |
| `state:done` | PR merged, task complete |
| `state:claim` | Claim and set up the branch without starting an agent |
| `mode:plan` / `mode:auto` / `mode:default` | Agent permission mode for this issue |

## 2. Configure

Edit `.joynt-foundry.yml`. The parts that matter most:

```yaml
repo: your-org/your-repo

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
    command: >-
      claude {permission_mode}
      -p "You are working on issue #{issue_number}: {title}.
      The issue is at {issue_url}. Read the issue body and implement the task.
      When done, create a commit with your changes."
      --verbose --output-format stream-json 2>&1 | tee {log_dir}/agent.log

# Preview environments (optional): a command or workflow you own
preview:
  mode: provider
  url_template: https://your-org.github.io/your-repo/previews/pr-{pr_number}/
  up_command:   gh workflow run preview-up.yml -f pr={pr_number} -f sha={sha} -f branch={branch}
  down_command: gh workflow run preview-down.yml -f pr={pr_number}
```

Under the GitHub Action, `worker`, `tmux_template`, `max_sessions`, and `poll_interval_seconds` are ignored. See [Configuration Reference](config-reference.md).

## 3. Choose how to run

### A. GitHub Action (recommended)

Add `.github/workflows/foundry.yml` from the template in [GitHub Action](github-action.md), and add the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Optionally add a GitHub App so Foundry's comments carry a bot name. Commit the workflow to the default branch; issue events only fire from there.

That is the whole setup. Nothing runs anywhere until an issue is labeled.

### B. Always-on runner

```bash
foundry setup-bot     # creates and installs a GitHub App; two browser clicks
foundry run           # poll → claim → spawn agent sessions
```

The machine must stay awake and online. See [GitHub Backends](github-backends.md) for identity options and `foundry serve` for a webhook-driven alternative to polling.

## 4. Create a task

Open a GitHub Issue with a clear brief and add the label `state:ready`. Add `mode:plan` first if you want to approve a plan before any code is written.

## 5. Watch it

**Action:** the job appears under Actions → Foundry. The job log is the agent transcript, and the transcript is also uploaded as an artifact. On the issue, Foundry maintains a status comment and moves the `state:*` label.

**Runner:**

```bash
foundry status          # overview
foundry sessions        # every task and its resources
foundry attach 42       # watch issue #42's agent live
```

## 6. Steer it

Comment on the issue:

| Comment | Effect |
|---|---|
| `@foundry continue <message>` | Resume or relaunch the agent with your message |
| `@foundry plan <message>` | Relaunch in plan mode |
| `@foundry replan` | Kill, re-read the issue body, relaunch |
| `@foundry restart` | Discard all work and start over |
| `@foundry start <message>` | Re-queue a failed or stopped task |
| `@foundry stop` | Stop and mark failed |

Or submit a PR review with **Request changes**; the review is fed back to the agent. Full details in [Workflows](workflows.md).

## 7. Stop it

**Action:** press Cancel on the run in the Actions UI, then `@foundry restart` or `@foundry start` to re-queue.

**Runner:** `foundry stop 42`, or Ctrl+C the `foundry run` process.
