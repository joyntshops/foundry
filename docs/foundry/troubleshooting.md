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

The token lacks a permission for that call. See the [permissions table](github-backends.md#permissions-reference). With the built-in token, grant it in the workflow's `permissions:` block. With a self-owned GitHub App, run `foundry setup-bot --check` first: it lists what the App lacks and which installation has not accepted the App's current permissions, each with the URL to fix it at. Add a permission on the App **and accept the permission update on the installation**; installations keep the old set until an org owner accepts. To check by hand what jobs actually get:

```bash
gh api orgs/YOUR_ORG/installations --jq '.installations[] | select(.app_slug=="YOUR_APP") | .permissions'
```

`Failed to create check run` in the log is this, for `checks: write`. It is a warning, not a failure.

## Two Foundry runs show as cancelled

The workflow declares `concurrency` at the workflow level instead of on the job, so Foundry's own comments enter the group before the `if:` filters them and cancel each other. Declare it on the job, as the template does ([GitHub Action](github-action.md#the-workflow)).

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

## `PR creation failed: GitHub Actions is not permitted to create or approve pull requests`

The run had only the job's built-in token (no App installed, no `FOUNDRY_APP_*` secrets; the log's token step says so), and the organization's Actions settings do not let that token open pull requests, which is GitHub's default for organizations. The agent's work is safe: the branch was pushed and the task is `state:failed`. [Install the App](https://github.com/apps/joynt-foundry/installations/new) and comment `@foundry go`; the task resumes from the branch and the PR is opened as the App.

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

## I approved the PR and Foundry logged `not merged: merge_failed (Repository rule violations found)`

The base branch's ruleset refused the merge; a human merging by hand usually succeeds because the admin role bypasses it. The common cause is a required status check bound to a source that no longer reports it: a rule that requires `Foundry Verification` from one GitHub App is never satisfied by the same check from another, and switching from a self-owned App to the public Foundry App changes the source. Compare the two:

```bash
gh api repos/OWNER/REPO/rules/branches/BRANCH --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
gh api repos/OWNER/REPO/commits/$(gh pr view N --json headRefOid -q .headRefOid)/check-runs --jq '.check_runs[] | "\(.name) \(.app.id) \(.app.slug)"'
```

When the `integration_id` in the rule is not the App that created the check run, point the rule at the App that does. Rulesets are replaced whole, so fetch the ruleset, change that one field, and put it back (`APP_ID` is the id of the App reporting the check; `5615485` for the public Foundry App, or `null` to accept the check from any source):

```bash
RULESET=$(gh api repos/OWNER/REPO/rules/branches/BRANCH --jq '.[] | select(.type=="required_status_checks") | .ruleset_id')
gh api repos/OWNER/REPO/rulesets/$RULESET \
  | jq '{name,target,enforcement,bypass_actors,conditions,rules}
        | (.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[] | select(.context=="Foundry Verification") | .integration_id) = APP_ID' \
  | gh api -X PUT repos/OWNER/REPO/rulesets/$RULESET --input -
```

The same change in the browser: the repository's Settings → Rules → Rulesets → the branch's ruleset → *Require status checks to pass*, where each check lists its source; set it to the App, or remove the row and add the check again choosing the right source. [GitHub Action](github-action.md#branch-protection-that-works-with-this) has the full list of settings.

## The preview is still up after the PR was merged by hand

Foundry tears a task's preview down when it completes the task: in the approval run when it merges the PR itself, otherwise in the `pull_request.closed` run. Before 0.1.58 the second path could not find the preview, because the merged PR was no longer the task's PR and the preview comment lives on it; the preview stayed up and its comment stayed *Live*. From 0.1.58 the closed run reads the comment on the merged PR, and `foundry preview down <issue>` does the same from any checkout. On an older version, run the repository's down command by hand for the PR number (for a GitHub Pages setup, dispatch its preview-down workflow).

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

## The broker

**"The job has no OIDC token" warning, PRs open as github-actions.** The workflow lacks `id-token: write` in its `permissions:` block. The shipped template has it; a hand-written workflow needs the line. Every job then continues on the built-in token, so agent PRs get no CI.

**"The Foundry App is not installed on this repository" warning.** The public App is not installed here, or was installed on only some repositories of the organization. Install it from the App's page, or set `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY` for a self-owned App. The run continued on the built-in token.

**"The broker answered HTTP 429" or "503 disabled".** The broker is throttled or switched off. Runs fall back to the built-in token until it returns; a repository that must not run without the App sets `required: true` on the `broker-token` step.

**Comments on the issue stay `github-actions[bot]` after the App was installed.** The claim and status comments are created once and updated in place, so a task that started under the built-in token keeps that author on them; everything created afterwards (the PR, the preview comment, new commits) carries the App's name. A fresh issue shows the App everywhere.

**Commits show as github-actions[bot] although the App token was used.** The `app-slug` input did not reach the Action (the template passes it from both token steps) or the bot user lookup failed; the run log's "Configure git identity" step says which.
