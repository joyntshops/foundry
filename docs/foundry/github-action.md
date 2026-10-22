# Foundry as a GitHub Action

`foundry action` runs the Foundry state machine for **one GitHub event** and exits. Packaged as the composite action at the repo root (`action.yml`), it is how Foundry runs: jobs that GitHub starts on demand. Nothing has to stay awake. State lives on GitHub.

This page is written for whoever picks this up next, human or agent. It records the non-obvious decisions so they are not rediscovered.

## What a run looks like

```
human comments "@foundry go" on an issue
  → job starts
  → foundry action: claim (labels + structured claim comment)
  → create worktree from origin/<branches.integration>
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
| `issue_comment.created` | body starts with `@foundry go`, by a user with write access, on an issue (not a PR) | start the issue, or proceed from the branch with the thread |
| `issue_comment.created` | `@foundry restart` | discard the branch, start over in the same job |
| `issue_comment.created` | `@foundry stop` | cancel the running job (concurrency), keep the branch, mark failed |
| `pull_request_review.submitted` | state is `changes_requested` | feed review back to agent |
| `pull_request_review.submitted` | state is `approved`, on a task PR or a `pull_request_bases` PR | rebase onto the base, wait for checks, merge (rebase method), `integration_rebuild`, complete the task or tear the promotion preview down |
| `pull_request.closed` | `merged` is true | `state:done`, close issue, preview down; then check sibling PRs for conflicts |
| `workflow_dispatch` | inputs `issue`, `command`, `message` | the command, as if commented; how Foundry hands work to itself |
| `pull_request.opened` / `synchronize` / `reopened` / `closed` | base in `preview.pull_request_bases` | preview up / redeploy / down for a non-task PR |
| `schedule` | | reconcile: in-progress issues with no status update for `reconcile_stale_minutes` are marked failed |

## Workflow template

```yaml
name: Foundry
on:
  issue_comment:       { types: [created] }
  pull_request:        { types: [opened, synchronize, reopened, closed] }
  pull_request_review: { types: [submitted] }
  workflow_dispatch:                       # Foundry dispatches itself; see gotchas
    inputs:
      issue:   { required: true,  type: string }
      command: { required: true,  type: string }
      message: { required: false, type: string, default: "" }
  schedule:
    - cron: '*/30 * * * *'                 # reconcile: catch runs that died without cleanup


# The job's built-in token does all of Foundry's GitHub writes.
permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: write        # gh workflow run for preview up/down
  deployments: write    # GitHub Deployment records for previews

jobs:
  foundry:
    # Comments: only `@foundry` commands, only on issues (not PRs), only from
    # people associated with the repo. The job re-checks the commenter's
    # permission (write or admin) before acting.
    if: >-
      (github.event_name == 'issue_comment' &&
        !endsWith(github.event.comment.user.login, '[bot]') &&
        !github.event.issue.pull_request &&
        startsWith(github.event.comment.body, '@foundry') &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)) ||
      (github.event_name == 'pull_request' &&
        (github.event.pull_request.merged == true ||
         github.event.pull_request.base.ref == 'main')) ||
      (github.event_name == 'pull_request_review' &&
        (github.event.review.state == 'changes_requested' || github.event.review.state == 'approved')) ||
      github.event_name == 'workflow_dispatch' ||
      github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 90
    concurrency:                                       # job-level, see gotchas
      group: foundry-${{ github.event.inputs.issue || github.event.issue.number || github.event.pull_request.number || github.event_name }}
      # `@foundry stop` cancels the running job for that issue; everything else queues.
      cancel-in-progress: ${{ github.event_name == 'issue_comment' && contains(github.event.comment.body, '@foundry stop') }}
    env:
      FOUNDRY_APP_ID: ${{ secrets.FOUNDRY_APP_ID }}   # secrets aren't readable in step `if:`
    steps:
      - id: app                                        # skipped when no App is configured
        if: env.FOUNDRY_APP_ID != ''
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.FOUNDRY_APP_ID }}
          private-key: ${{ secrets.FOUNDRY_APP_PRIVATE_KEY }}
      - uses: actions/checkout@v4
        with:
          token: ${{ steps.app.outputs.token || github.token }}
          fetch-depth: 0
      - id: foundry
        uses: joyntshops/foundry@main
        with:
          github-token: ${{ steps.app.outputs.token || github.token }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      - if: always() && steps.foundry.outputs.log-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: foundry-issue-${{ steps.foundry.outputs.issue }}-run-${{ github.run_id }}
          path: ${{ steps.foundry.outputs.log-dir }}
          if-no-files-found: ignore
```

`.joynt-foundry.yml` in the target repo configures everything; see [Configuration Reference](config-reference.md).

## Secrets

| Secret | Required | What it is |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | From `claude setup-token`. Runs bill the subscription of the person who generated it, not the API. Tied to that person; for an org-shared secret Anthropic recommends `ANTHROPIC_API_KEY` instead. |
| `FOUNDRY_APP_ID`, `FOUNDRY_APP_PRIVATE_KEY` | no | A GitHub App installed on the repo. When present, the template mints an installation token and Foundry acts as the App. When absent, the job's built-in token is used. |

No GitHub credentials are *needed*. Inside a job, GitHub has already established identity: `${{ github.token }}` is scoped to the repo, carries the permissions the workflow grants, and dies with the job.

### What the App adds

- **A named bot.** Comments, labels, and PRs appear as `<YourApp>[bot]` instead of `github-actions[bot]`.
- **CI on the PRs Foundry opens.** Pushes and PRs made with the built-in token do not trigger `push` or `pull_request` workflows, so a repo's CI would silently skip agent PRs and required checks could never pass. With an App token they run normally.

The App from `foundry setup-bot` works. It needs **issues, pull_requests, contents, checks, actions, deployments: write**. Older Apps lack `checks` (verification results are posted as a Check Run; without it you get a non-fatal warning), `actions` (preview dispatch), and `deployments`. Add them in the App's settings, then **accept the permission update on the installation**: changing the App definition only creates a request, and jobs keep minting tokens with the old set until an org owner accepts it.

The template's `if: env.FOUNDRY_APP_ID != ''` exists because the `secrets` context is not available in a step's `if:`. Surfacing the App ID (not the key) into `env` makes the check possible; `steps.app.outputs.token || github.token` falls back when the step was skipped.

## Decisions and gotchas

**Nothing Foundry does may depend on triggering another run.** Events caused by the job's built-in token do not start workflow runs, with two exceptions: `workflow_dispatch` and `repository_dispatch`. Preview up/down use `gh workflow run`, which is `workflow_dispatch`, so they are fine. Merges are done by humans, so `pull_request.closed` fires. `@foundry restart` discards the task and starts it again inside the same job rather than putting a label back and hoping. Design any new transition the same way: finish it in-job, or make it a dispatch.

**No branching on prose.** What happens after the agent exits is decided from facts Foundry can check (run error, commits) and the agent's typed report (`done`, `needs_input`, `plan_ready`, `blocked`), submitted as Claude Code structured output or via `foundry report`. Contradictions and missing reports fail closed. The regex heuristics this replaced misread "I have not completed this" as completion and treated "can't tell" as success. Details in [Agent Backends](agent-backends.md#the-agent-report).

**Approval is the merge button.** An approving review on a task PR, or on a promotion PR into a `pull_request_bases` branch, runs the same flow `foundry review` does from a checkout: rebase the branch onto its base and push with `--force-with-lease`, wait for the PR's checks on the rebased head, merge with the rebase method, run `integration_rebuild`, and finish the lifecycle in the same job (task → `state:done`, promotion PR → preview down). A conflict sends the task's agent to rebase and asks for a second approval once it is clean. Red or still-pending checks stop before the merge, with the reason on the PR. The job's own check (`GITHUB_JOB`) is ignored while waiting, since it is never finished while it looks at itself. `review.merge_on_approval: false` turns this off. Branch protection with *require up to date* and *linear history* is compatible and recommended; GitHub still does not run review workflows on a PR with conflicts, so approve after it is clean.

**Stale PRs are handled from the merge, never from reviews.** When a PR merges into `integration`, the same job lists the other open Foundry PRs into that base, waits for GitHub to recompute mergeability, and for each one that now conflicts dispatches the workflow with a `continue` command carrying a rebase instruction. `workflow_dispatch` is used because it is one of the two event types GitHub delivers even when the job's own token caused it, and the dispatched job runs under the conflicting issue's own concurrency group. Reviews cannot do this: GitHub does not run `pull_request_review` workflows for a PR that has conflicts.

**Relaunch pushes use `--force-with-lease`.** An agent sent back to a branch may rebase. The lease is the remote-tracking ref the job fetched when it recreated the worktree, so a push by anyone else in the meantime is still refused.

**Consecutive transitions happen inside one job.** Claim → agent → verify → PR → preview-up is a single run. A new job is only needed when a human acts. This keeps runner spin-ups to one per human interaction.

**Concurrency groups replace the claim race.** `concurrency.group: foundry-<issue>` makes GitHub serialise runs per issue. The claim protocol's one-second sleep and read-back were written for two runners racing to claim; here that cannot happen. The structured claim comment is kept as the audit record and as the source for task recovery.

**Declare concurrency on the job, not the workflow.** GitHub keeps at most one *pending* run per group and cancels the rest. A workflow-level group admits every triggered run before the job `if:` is evaluated, so Foundry's own comments and labels (filtered out by `if:`) still enter the group, queue behind the active run, and cancel each other. A pending human `@foundry` command could be the one cancelled. Job-level concurrency is evaluated only for jobs that pass `if:`. Seen on the first real run as two "cancelled" Foundry runs.

**Task state is rebuilt from GitHub every run.** The file store under `~/.joynt-foundry/` is empty in every fresh job. `lib/task-recovery.ts` reconstructs a `TaskState` from the latest claim comment (`<!-- foundry-claim-block -->`), the issue's current `state:*` label, the PR for the branch, and the preview comment (`<!-- foundry-preview -->`). This is why the single-state-label invariant (`setStateLabel`) is load-bearing: recovery reads the label to learn the status.

**There is no session resume; there is a hand-off.** `claude --resume` would need the session file from the job that asked, and that job is gone. Instead: when a job ends with the agent waiting (question or plan), Foundry commits anything uncommitted and pushes the branch. When the human answers, the next job recreates the worktree from that branch and relaunches the agent with `FOUNDRY_RESUME_CONTEXT` set to "you stopped because X; the human replied Y; continue from the branch, do not start over". The preset's prompt includes that variable. The human replies with `@foundry go <answer>`; a plain reply is context for the next launch and starts nothing.

**Stopping a run.** `@foundry stop` works: the template sets `cancel-in-progress` for that comment, so GitHub cancels the issue's running job, the action's `if: cancelled()` step marks the task failed, and the stop command's own job tears the preview down. Cancel from the Actions UI has the same effect through the same cleanup step. Either way the issue never stays at `state:in-progress` with nothing running.

**Runs that die silently are reconciled.** A runner failure or the six-hour limit can end a job with no cleanup. The `schedule` trigger runs `foundry reconcile`: any `state:in-progress` issue whose status comment is older than `reconcile_stale_minutes` (default 120) is marked failed with a note. Set the threshold above your job `timeout-minutes`.

**Cost is visible per issue.** The status comment's `Last run` row shows the cost, turns, and duration the agent CLI reported. `agent_max_turns` (default 150) caps a runaway session; the preset passes it as `--max-turns`.

**The Claude Code version is pinned** in `action.yml` (`claude-code-version`). Four CLI behaviours surprised us on the first day; a release should not change Foundry under you. Bump deliberately, or pass `latest`.

**The `if:` filter matters for cost and for safety.** Every `issue_comment` event, including Foundry's own status comments, would otherwise start a runner that does ~40 seconds of setup and exits. The filter in the template starts a job only for `@foundry` comments on issues from `OWNER`/`MEMBER`/`COLLABORATOR` authors, PR events on listed bases or merges, reviews, dispatches, and the schedule. `author_association` is on the comment payload, so it costs nothing to check; it is coarse (a `MEMBER` may have read access only), which is why the job then asks the API for the commenter's actual permission and requires write.

**Who may start a run is Foundry's to decide, not GitHub's.** A GitHub App's permissions govern what the App may do to the repo, not who may address it; the event that starts a job is a comment, and anyone who can see the issue can comment. There is no native "only these users may invoke this App" setting. Interaction limits and conversation locks exist but are blunt. The two gates above are the mechanism.

**Stacked PRs only retarget if the base branch is deleted.** Learned the hard way: a PR stacked on a feature branch merged into that branch instead of `main` because the feature branch was kept at merge time. Merge with "Delete branch" or expect to open a follow-up PR.

Symptoms and fixes from real runs are collected in [Troubleshooting](troubleshooting.md#github-action).

## Known limitations

- `@foundry` commands left as **PR comments** are not yet resolved to their issue and are ignored. Comment on the issue.
- No verify-to-agent retry loop yet: a verification failure posts the output, pushes the branch, and marks the task failed; `@foundry go` sends the agent back to it.
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
