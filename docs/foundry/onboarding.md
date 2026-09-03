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
| `state:ready` | Task ready for Foundry to claim |
| `state:in-progress` | Task claimed; agent running |
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

See [Configuration Reference](config-reference.md) for every key.

## 3. Add the workflow and the secret

Add `.github/workflows/foundry.yml` from the template in [GitHub Action](github-action.md) and commit it to the default branch; issue events only fire from there. Add the repository secret `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

Optionally run `foundry setup-bot` to create a GitHub App and add its ID and private key as secrets. With them, Foundry's comments and PRs carry the App's name and its pushes trigger your other workflows. Without them, the job's built-in token is used and everything still works.

Nothing runs anywhere until an issue is labeled.

## 4. Create a task

Open a GitHub Issue with a clear brief and add the label `state:ready`. Add `mode:plan` first if you want to approve a plan before any code is written.

## 5. Watch it

The job appears under Actions → Foundry. The job log is the agent transcript, and the transcript is uploaded as an artifact. On the issue, Foundry maintains a status comment and moves the `state:*` label.

## 6. Steer it

Comment on the issue:

| Comment | Effect |
|---|---|
| `@foundry continue <message>` | Relaunch the agent with your message |
| `@foundry plan <message>` | Relaunch in plan mode |
| `@foundry replan` | Re-read the issue body and relaunch |
| `@foundry restart` | Discard all work and start over |
| `@foundry start <message>` | Re-queue a failed or stopped task |
| `@foundry stop` | Mark failed |

Or submit a PR review with **Request changes**; the review is fed back to the agent. Full details in [Workflows](workflows.md).

## 7. Stop or undo

To stop a running job, press **Cancel** on the run in the Actions UI, then `@foundry restart` or `@foundry start` to re-queue. To undo a task entirely from any checkout:

```bash
foundry reset 42 --force     # remove branch, PR, preview; back to state:ready
```
