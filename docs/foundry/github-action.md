# Foundry as a GitHub Action

`foundry action` runs the Foundry state machine for **one GitHub event** and exits. Packaged as the composite action at the repo root (`action.yml`), it replaces the always-on `foundry run` daemon with jobs that GitHub starts on demand. Nothing has to stay awake. State lives on GitHub.

This page is written for whoever picks this up next, human or agent. It records the non-obvious decisions so they are not rediscovered.

## What a run looks like

```
issue labeled state:ready
  → job starts
  → foundry action: claim (labels + structured claim comment)
  → create worktree from origin/integration
  → run the agent as a subprocess of the job (transcript = job log)
  → wait; classify outcome from the stream-json log
  → completed: verify → push → PR to integration → state:ready-for-human-review → preview up
    needs-input: post questions → state:waiting-for-input
    plan-completed: post plan → state:plan-review
  → job ends
```

A human then acts on GitHub. Each action is another event, another job:

| GitHub event | Condition | Foundry transition |
|---|---|---|
| `issues.labeled` | label is `state:ready` | claim + run agent |
| `issues.labeled` | label is `state:claim` | claim only, no agent |
| `issue_comment.created` | body starts with `@foundry <cmd>` | `continue`, `plan`, `start`, `restart`, `replan`, `stop` |
| `pull_request_review.submitted` | state is `changes_requested` | feed review back to agent |
| `pull_request.closed` | `merged` is true | `state:done`, close issue, preview down |

## Workflow template

```yaml
name: Foundry
on:
  issues:              { types: [labeled] }
  issue_comment:       { types: [created] }
  pull_request:        { types: [closed] }
  pull_request_review: { types: [submitted] }

concurrency:
  group: foundry-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  foundry:
    if: >-
      (github.event_name == 'issues' &&
        (github.event.label.name == 'state:ready' || github.event.label.name == 'state:claim')) ||
      (github.event_name == 'issue_comment' &&
        contains(github.event.comment.body, '@foundry') &&
        !endsWith(github.event.comment.user.login, '[bot]')) ||
      (github.event_name == 'pull_request' && github.event.pull_request.merged == true) ||
      (github.event_name == 'pull_request_review' && github.event.review.state == 'changes_requested')
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - id: app
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.FOUNDRY_APP_ID }}
          private-key: ${{ secrets.FOUNDRY_APP_PRIVATE_KEY }}
      - uses: actions/checkout@v4
        with:
          token: ${{ steps.app.outputs.token }}
          fetch-depth: 0
      - id: foundry
        uses: joyntshops/foundry@main
        with:
          github-token: ${{ steps.app.outputs.token }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      - if: always() && steps.foundry.outputs.log-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: foundry-issue-${{ steps.foundry.outputs.issue }}-run-${{ github.run_id }}
          path: ${{ steps.foundry.outputs.log-dir }}
          if-no-files-found: ignore
```

`.joynt-foundry.yml` in the target repo is read exactly as `foundry run` reads it. The `worker` setting is ignored: the action always uses the `subprocess` worker.

## Secrets

| Secret | What it is |
|---|---|
| `FOUNDRY_APP_ID`, `FOUNDRY_APP_PRIVATE_KEY` | A GitHub App installed on the repo with **issues, pull_requests, contents, actions, deployments: write**. `foundry setup-bot` creates one; add `actions` and `deployments` to it. |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Runs bill the subscription of the person who generated it, not the API. Tied to that person; for an org-shared secret Anthropic recommends `ANTHROPIC_API_KEY` instead. |

## Decisions and gotchas

**Writes must come from a GitHub App, never `GITHUB_TOKEN`.** GitHub does not fire workflow events for changes made with the default token. If Foundry labelled an issue with `GITHUB_TOKEN`, the `issues.labeled` event would never fire and the state machine would stall after one step. The App token is minted per job with `actions/create-github-app-token` and passed to both `actions/checkout` (so pushes are made as the App) and the action (so labels, comments, PRs, and `gh workflow run` are).

**Consecutive transitions happen inside one job.** Claim → agent → verify → PR → preview-up is a single run. A new job is only needed when a human acts. This keeps runner spin-ups to one per human interaction.

**Concurrency groups replace the claim race.** `concurrency.group: foundry-<issue>` makes GitHub serialise runs per issue. The claim protocol's one-second sleep and read-back existed for two pollers racing; here they cannot. The structured claim comment is kept as the audit record and as the source for task recovery.

**Task state is rebuilt from GitHub every run.** The file store under `~/.joynt-foundry/` is empty in every fresh job. `lib/task-recovery.ts` reconstructs a `TaskState` from the latest claim comment (`<!-- foundry-claim-block -->`), the issue's current `state:*` label, the PR for the branch, and the preview comment (`<!-- foundry-preview -->`). This is why the single-state-label invariant (`setStateLabel`) is load-bearing: recovery reads the label to learn the status.

**Session resume does not survive jobs.** `claude --resume <session_id>` needs the session file from the runner that started it. That runner is gone. `@foundry continue` therefore relaunches the agent with the human's message and the issue as context rather than resuming. The `resume_command` in config is effectively unused under the action.

**Cancelling from the Actions UI is the supported way to stop a run.** `@foundry stop` on a running job cannot reach into the job. Press Cancel on the run. A cleanup step that fixes labels on cancel is a planned addition; until then, `@foundry restart` or `@foundry start` re-queues.

**The `if:` filter matters for cost.** Every `issues.labeled` event, including the ones Foundry itself causes, would otherwise start a runner that does ~40 seconds of setup and exits. The filter in the template starts a job only for `state:ready`, `state:claim`, `@foundry` comments from humans, merged PRs, and change-request reviews.

**Stacked PRs only retarget if the base branch is deleted.** Learned the hard way: a PR stacked on a feature branch merged into that branch instead of `main` because the feature branch was kept at merge time. Merge with "Delete branch" or expect to open a follow-up PR.

## Known limitations (as of first version)

- `@foundry` commands left as **PR comments** are not yet resolved to their issue. Comment on the issue.
- No verify-to-agent retry loop yet: a verification failure posts the output and marks the task failed.
- No `if: cancelled()` label cleanup step yet.
- `deployment_id` is not recovered, so preview-down under the action cannot mark a GitHub Deployment inactive; the target repo's teardown workflow should do that itself (the demo's does).

## Outputs

`issue`, `status`, `branch`, `pr-url`, `log-dir`, `log-path`. Upload `log-dir` as an artifact to keep the agent transcript beyond the job log.

## Local dry run

```bash
cd path/to/target-repo   # where .joynt-foundry.yml lives
node path/to/foundry/packages/foundry/dist/cli.js action \
  --event-name issues --event-path ./some-payload.json
```

Any payload that maps to no Foundry event (a non-state label, an unmerged PR close) exits 0 after task recovery, which makes for a cheap read-only check that auth and config are wired.
