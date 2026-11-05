# Foundry as a GitHub Action

Foundry runs as jobs that GitHub starts on demand. Each GitHub event that matters starts one job; the job performs one transition of the task's state machine and exits. Nothing stays awake, and the task's state lives on GitHub: in labels, a structured claim comment, the PR, and the preview comment. This page is what a repository owner needs to know about that: which events do what, what the workflow needs, what the GitHub App adds, and which branch rules work with it.

## What a run looks like

```
human comments "@foundry go" on an issue
  → job starts
  → claim (state:in-progress + structured claim comment)
  → worktree from origin/<branches.integration>
  → the agent runs as a subprocess of the job (its transcript is the job log)
  → the agent's typed report decides what happens next:
      done:        verify → push → PR into integration → state:ready-for-human-review → preview up
      needs input: questions posted → state:waiting-for-input
      plan ready:  plan posted → state:plan-review
  → job ends
```

A human then acts on GitHub. Each action is another event, another job:

| GitHub event | Condition | What Foundry does |
|---|---|---|
| `issue_comment.created` | body starts with `@foundry go`, by a user with write access, on an issue (not a PR) | start the issue, or proceed from the branch with the thread |
| `issue_comment.created` | `@foundry restart` | discard the branch, start over in the same job |
| `issue_comment.created` | `@foundry stop` | cancel the running job, keep the branch, mark the task failed |
| `pull_request_review.submitted` | state is `changes_requested` | send the review to the agent |
| `pull_request_review.submitted` | state is `approved`, on a task PR or a `pull_request_bases` PR | rebase onto the base, wait for checks, merge (rebase method), run `integration_rebuild`, complete the task or tear the promotion preview down |
| `pull_request.closed` | `merged` is true | `state:done`, close the issue, preview down; then send the agent back to sibling PRs that now conflict |
| `workflow_dispatch` | inputs `issue`, `command`, `message` | the command, as if commented; also how Foundry hands work to itself |
| `pull_request.opened` / `synchronize` / `reopened` / `closed` | base in `preview.pull_request_bases` | preview up / redeploy / down for a PR that is not a task |
| `schedule` | | reconcile: in-progress issues with no status update for `reconcile_stale_minutes` are marked failed |

Everything from the claim to the preview happens inside one job; a new job starts only when a human acts, so each human interaction costs one runner start.

## The workflow

`foundry init` writes `.github/workflows/foundry.yml` from [the shipped template](../../packages/foundry/templates/foundry.yml), with the repository's production branch in its PR filter. That file is the single source; copy it rather than writing your own. It pins `uses: joyntshops/foundry@v0`, the moving major tag that every release updates, so the repository follows releases rather than every merge; pin an exact `@vX.Y.Z` to freeze. Everything else is configured in `.joynt-foundry.yml` ([Configuration](config-reference.md)).

Three parts of the template matter if you edit it:

- **The `if:` filter.** Every `issue_comment` event, including Foundry's own status comments, would otherwise start a runner that does about forty seconds of setup and exits. The filter starts a job only for `@foundry` comments on issues from `OWNER`, `MEMBER` and `COLLABORATOR` authors, PR events on listed bases or merges, reviews, dispatches, and the schedule. The job then checks the commenter's actual repository permission and requires write.
- **Job-level concurrency.** `concurrency.group: foundry-<issue>` serialises runs per issue and makes `@foundry stop` cancel the running job. Declare it on the job, not the workflow: a workflow-level group admits every triggered run before the `if:` is evaluated, so Foundry's own comments enter the group and cancel each other.
- **The schedule.** The `schedule` trigger runs `foundry reconcile`, which marks any `state:in-progress` issue whose status comment is older than `reconcile_stale_minutes` (default 120) as failed, so a job that died without cleanup (a runner failure, the six-hour limit) never leaves an issue stuck. Set the threshold above the job's `timeout-minutes`.

Comment, schedule and dispatch runs use the workflow and `.joynt-foundry.yml` from the **default branch**, and the worktree is then cut from `origin/<branches.integration>`, which may be a different branch. On a repository that promotes `test` to `main`, a change to the config governs comment-triggered runs only once it reaches `main`; `gh workflow run foundry.yml --ref test` reads it immediately. `pull_request` and `pull_request_review` events run from the PR's head.

## Secrets

| Secret | Required | What it is |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | From `claude setup-token`. Runs bill the subscription of the person who generated it, not the API. For an organization-shared secret Anthropic recommends `ANTHROPIC_API_KEY` instead. |
| `FOUNDRY_APP_ID`, `FOUNDRY_APP_PRIVATE_KEY` | only for a self-owned App | With the public Foundry App there are no App secrets: the job exchanges its OIDC token at the broker ([below](#broker-mode)). With a self-owned App, the template mints an installation token from these. With neither, the job's built-in token is used; see [what the App adds](#what-the-app-adds) for what that costs. |

No GitHub credentials are needed to run at all. Inside a job, GitHub has already established identity: `${{ github.token }}` is scoped to the repository, carries the permissions the workflow grants, and dies with the job.

### What the App adds

- **A named bot.** Comments, labels, PRs and commits appear as `joynt-foundry[bot]` (or `<YourApp>[bot]`) instead of `github-actions[bot]`.
- **CI on the PRs Foundry opens.** Pushes and PRs made with the built-in token do not trigger `push` or `pull_request` workflows, so a repository's CI would silently skip agent PRs and required checks could never pass. On some repositories the run is created but held at "1 workflow awaiting approval", which includes this workflow's own `pull_request` trigger. With an App token they run normally. On an organization with GitHub's default Actions settings the built-in token cannot open a pull request at all ([Troubleshooting](troubleshooting.md#pr-creation-failed-github-actions-is-not-permitted-to-create-or-approve-pull-requests)).

The public Foundry App carries every permission Foundry needs. A self-owned App from `foundry setup-bot` works the same way and needs **issues, pull_requests, contents, checks, actions, deployments, workflows: write**; `foundry setup-bot --check` audits it ([GitHub Identity](github-backends.md)).

The template's `if: env.FOUNDRY_APP_ID != ''` on the self-owned step exists because the `secrets` context is not available in a step's `if:`; surfacing the App ID (not the key) into `env` makes the check possible. The Action then takes `steps.app.outputs.token || steps.broker.outputs.token || github.token`, in that order, so a self-owned App always wins and the built-in token is the last resort.

### Broker mode

The public Foundry App has no key to store. The job proves who it is with the OIDC token GitHub issues to every job that has `permissions: id-token: write` (the template grants it), and a broker run by the App's owner turns that into an installation token for this one repository.

The template runs the exchange **before checkout**, through `joyntshops/foundry/broker-token@v0`, because `actions/checkout` persists the token it is given for every later `git push`; a token minted after checkout would leave pushes running as `github-actions`. The step is skipped when `FOUNDRY_APP_ID` is set. The Action itself also accepts `broker-url` and performs the exchange when it was handed the built-in token, rewriting git's credential afterwards; that path serves hand-written workflows and is slower by one step.

| | |
|---|---|
| Needs | `id-token: write`; the App installed on the repository; the broker reachable |
| Yields | a token valid one hour, scoped to this repository, carrying the App's permissions; the App's slug for commit attribution |
| On failure | a **warning** on the run and empty outputs, so the job continues with the built-in token (PRs then get no CI). `required: true` on the step, or `broker-required: true` on the Action, makes it fail instead |
| Refusals | `not_installed` (install the App or set the self-owned secrets), `deny_list`, `workflow_ref`, `disabled` (the broker's kill switch) |

A fork pull request never gets `id-token: write`, so a fork cannot obtain the upstream repository's token; the template does not run on fork PRs anyway. The broker URL is the default of the `broker-url` input on both actions; pass your own to use a broker you run against your own App ([the broker](../../packages/broker/README.md)).

## Approval and merge

An approving review on a task PR, or on a promotion PR into a `pull_request_bases` branch, is the merge button. Foundry rebases the branch onto its base and pushes it; when that changed the head, it runs `verify` again and publishes the result as a new **Foundry Verification** check run, because the agent's run is on the old head and the commit being merged needs its own; it then waits for the PR's checks, merges with the rebase method, runs `integration_rebuild`, and finishes the lifecycle in the same job. A conflict, or a verify failure on the rebased head, sends the agent back and asks for a second approval once it is green. Red or still-pending checks stop before the merge, with the reason on the PR. `review.merge_on_approval: false` turns this off. Preview verification is not repeated after the rebase.

After any merge into the integration branch, the same job lists the other open Foundry PRs into that base and, for each one that now conflicts, dispatches the agent with a rebase instruction.

## Branch protection that works with this

Require pull requests with one approval, the repository's own CI as required status checks with *require branches to be up to date*, *linear history*, and the rebase merge method allowed. Then:

- Do not enable *dismiss stale approvals on push* or *require approval of the most recent push*: Foundry's rebase pushes after the approval, and the merge needs that approval to still stand.
- Foundry waits on check runs (the Checks API), not commit statuses, so a required commit status such as a hosting provider's is not waited for and the merge can be refused while it is pending.
- `Foundry Verification` exists only on PRs Foundry opened, so requiring it blocks every human PR into the same branch. Require it only once every PR gets it (a `pull_request` workflow that runs the same commands, under a different check name so the two sources do not share one). A required check is bound to the App that reports it: a rule bound to one App is never satisfied by the same check from another ([Troubleshooting](troubleshooting.md#i-approved-the-pr-and-foundry-logged-not-merged-merge_failed-repository-rule-violations-found)).
- GitHub does not run review workflows on a PR with conflicts, so approve after it is clean.
- Nothing Foundry does pushes to the protected branches directly, so deletion and force-push rules on them cost nothing.

## Known limitations

- `@foundry` commands left as **PR comments** are not resolved to their issue and are ignored. Comment on the issue.
- No verify-to-agent retry loop yet: a verification failure posts the output, pushes the branch, and marks the task failed; `@foundry go` sends the agent back to it.
- `deployment_id` is not recovered between jobs, so preview-down under the Action cannot mark the GitHub Deployment record inactive; have the teardown workflow do it.

## Outputs

`issue`, `status`, `branch`, `pr-url`, `log-dir`, `log-path`. Upload `log-dir` as an artifact to keep the agent transcript beyond the job log; the template does.
