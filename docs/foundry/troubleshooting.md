# Troubleshooting

Everything below was hit on real runs.

## Nothing happened after I commented `@foundry go`

1. The workflow must be on the **default branch**. `issue_comment` events only trigger workflows from there.
2. The comment must *start* with `@foundry go` (or whatever `comment_triggers.go` says). A mention mid-sentence is just text.
3. You must have **write** access to the repository. The workflow `if:` admits only `OWNER`/`MEMBER`/`COLLABORATOR` authors, and the job then checks the actual permission and logs `write access ... is required` when it refuses.
4. Check Actions → Foundry. A run marked **skipped** means the job's `if:` filtered the event; that is expected for Foundry's own comments.
5. `.joynt-foundry.yml` must exist at the repo root on that branch.
6. Comments on the **PR** are ignored; comment on the issue.

## I added `state:ready` (or another label) and nothing happened

Labels are status, not commands. Only Foundry sets `state:*`. Comment `@foundry go`.

## `Resource not accessible by integration`

The token lacks a permission for that call. See the [permissions table](github-backends.md#permissions-reference). With the built-in token, grant it in the workflow's `permissions:` block. With a GitHub App, add it on the App **and accept the permission update on the installation**; installations keep the old set until an org owner accepts. Check what jobs actually get:

```bash
gh api orgs/YOUR_ORG/installations --jq '.installations[] | select(.app_slug=="YOUR_APP") | .permissions'
```

`Failed to create check run` in the log is this, for `checks: write`. It is a warning, not a failure.

## Two Foundry runs show as cancelled

The workflow declares `concurrency` at the workflow level instead of on the job, so Foundry's own comments enter the group before the `if:` filters them and cancel each other. Declare it on the job, as the template does; the reason is under [Decisions](github-action.md#decisions-and-gotchas).

## The agent exited immediately, outcome `errored`

Usually authentication. Open the run's transcript artifact (`foundry-issue-<n>-run-<id>`) or the job log and look at the first lines from `claude`. Confirm `CLAUDE_CODE_OAUTH_TOKEN` is set as a secret the repo can see:

```bash
gh api repos/OWNER/REPO/actions/organization-secrets --jq '.secrets[].name'   # org-level
gh secret list --repo OWNER/REPO                                                # repo-level
```

The token is tied to the Claude subscription of whoever ran `claude setup-token`, and it expires; regenerate and update the secret.

`The agent run failed: Failed to authenticate. API Error: 401 Invalid bearer token` with the secret present means the value is wrong, most often whitespace: a token pasted with a trailing newline. Set it trimmed: `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO --body "$(pbpaste | tr -d '[:space:]')"`. (Older Foundry versions printed this as "failed (success)", the CLI's own subtype for that case.)

## `gh secret set` hangs

It is waiting for the value on an interactive prompt that some terminals (the Claude desktop app's, for one) never deliver. Pass `--body` or redirect a file: `gh secret set FOUNDRY_APP_PRIVATE_KEY --repo OWNER/REPO < ~/.joynt-foundry/github-app-ORG.pem`.

## The PR shows "1 workflow awaiting approval"

The PR was opened with the job's built-in token, so GitHub holds `pull_request` runs for it, including this workflow's own. Install the App (`foundry setup-bot`, then the two secrets); PRs it opens trigger normally. The PR that is already stuck can be finished by approving it: the review event is yours, and Foundry merges in that job.

## I changed `.joynt-foundry.yml` and nothing changed

Comment-triggered runs read the config from the default branch. Until the change is promoted there, run the issue by dispatch against the branch that has it: `gh workflow run foundry.yml --ref <branch> -f issue=<n> -f command=go`. The same applies to the workflow file and to the model.

## The preview check failed on the promotion PR only

The PR's head is the integration branch, which on Vercel is often the test project's *production* branch, so its commit has a Production deployment on which a preview-only host override is off. Host-keyed endpoints return nothing on the generated hostname. Have the preview script print the project's production alias for Production deployments; see [Preview Environments](preview-environments.md#vercel-through-its-github-integration).

## `gh api orgs/.../installations` returns 403

It needs org-owner rights. Without them, prove the App with a no-op dispatch (`-f command=stop` on an issue with no task) and read the token-mint step in the run.

## `The agent finished without submitting a report`

Foundry decides what happens next from a typed report, never from the agent's prose, and fails closed without one. A custom backend `command` written before v0.1.36 lacks it. Either switch to `preset: claude-code`, or add `--json-schema "$FOUNDRY_REPORT_SCHEMA"` to a Claude Code command, or have another agent run `foundry report` before exiting. See [The agent report](agent-backends.md#the-agent-report).

## `The agent reported the task done, but the branch has no commits`

Exactly that: the report said `done` and git disagrees. Usually the agent edited files and never committed. `@foundry go` with "commit your changes" (the branch, if anything was committed, is kept), or `@foundry restart`.

## Verification failed

Foundry labels the task `state:failed` and posts each command's result and the failing output on the issue. The branch is pushed. Fix the cause (often the verify command itself, or a dependency the runner image lacks) and `@foundry go`, or check the branch out locally and run the commands by hand. A verify-to-agent retry loop is planned; today a failure stops the task.

## Verification failed on the install step instantly, with no output

`yarn install` failing in under a second means the wrong Yarn ran: the repo pins Yarn 2+ through `packageManager` in `package.json` and expects corepack, which the runner has disabled. Foundry enables corepack for such repos since v0.1.49; on an older pin, commit the Yarn release instead (`yarn set version <v>` writes `.yarn/releases/` and `yarnPath`). Empty output on a failed step was a Foundry bug fixed in the same release (stderr was dropped); upgrade to see the real error.

## A PR went stale after another one merged

Foundry handles this: after any merge into `integration`, it checks the other open Foundry PRs and, for each that now conflicts, posts a note on the issue and dispatches the agent with a rebase instruction. If the note says Foundry *could not* start the agent, the workflow is missing the `workflow_dispatch` trigger or `actions: write`; add them from the template, then reply with the quoted instruction. Requesting changes on the conflicting PR does nothing, because GitHub runs no workflow for a PR with conflicts.

## `@foundry go` on a PR comment did nothing

Not yet supported: a comment on the PR carries the PR number, not the issue number. Comment on the issue instead.

## `@foundry stop` did nothing

The workflow must set `cancel-in-progress` for stop comments (template: `cancel-in-progress: ${{ github.event_name == 'issue_comment' && contains(github.event.comment.body, '@foundry stop') }}`). Without it the stop job queues behind the running one. Cancelling from the Actions UI always works, and the action's `if: cancelled()` step marks the task failed.

## An issue is stuck at `state:in-progress` with no run

The job died without cleanup (runner failure, `timeout-minutes`, or an older template without the cancel step). The `schedule` trigger runs `foundry reconcile` and marks such issues failed once the status comment is older than `reconcile_stale_minutes`. To do it now from a checkout: `foundry reconcile`. Then `@foundry go` to continue from the branch, or `@foundry restart` to start over.

## I answered the agent's question and nothing happened

A plain reply starts nothing; it is kept as context for the next launch. Answer with `@foundry go <answer>` on the **issue** (not the PR). Older workflow templates admitted plain replies on waiting issues; the current one does not.

## The relaunched agent lost its earlier work

It should not: when a job ends with the agent waiting, Foundry commits anything uncommitted (`chore(foundry): work in progress`) and pushes the branch, and the status comment says "Work so far is on `<branch>`". If that line is missing, the push failed; the job log says why (usually permissions). The next job recreates the worktree from the pushed branch.

## Where are the logs?

- The job log is the full agent transcript, streamed live.
- The same transcript (`agent.log`, stream-json) is uploaded as an artifact named `foundry-issue-<n>-run-<id>` when the template's upload step is present.
- On the issue, the status comment records each transition.

## How do I test a Foundry change before merging it?

Point the workflow at a branch: `uses: joyntshops/foundry@your-branch`. Composite actions are built from whatever ref you name. Switch back to `@v0` after merging; the moving major tag reaches the merged change at the next release, a few minutes after the merge ([Releasing](releasing.md)).

## A task is in a bad state and I want to start over

```bash
foundry reset 42            # dry run: shows what it would remove
foundry reset 42 --force    # preview down, close PR, delete branch, clear the state label
```

Works from any checkout; the task is rebuilt from the issue's claim comment.

## Local files

CLI commands and jobs use `~/.joynt-foundry/` for App credentials (from `setup-bot`), transcripts, and a per-repo state file that is only a cache; deleting it loses nothing that is not on GitHub, except the App credentials.

```
~/.joynt-foundry/
├── github-app-<org>.json / .pem     from setup-bot
├── state-<org>__<repo>.json         cache; rebuilt from GitHub
└── logs/<org>__<repo>/<issue>/agent.log
```

## Debug output

```bash
foundry --verbose reset 42
```

In a workflow, set `ACTIONS_STEP_DEBUG=true` as a repository variable for verbose runner logs.
