# Troubleshooting

Everything below was hit on real runs. Fixes are in the version noted where relevant.

## Nothing happened after I added `state:ready`

1. The workflow must be on the **default branch**. `issues` and `issue_comment` events only trigger workflows from there.
2. The label must be exactly what `.joynt-foundry.yml` says under `labels.ready` (default `state:ready`).
3. Check Actions → Foundry. A run marked **skipped** means the job's `if:` filtered the event; that is expected for labels Foundry adds itself.
4. `.joynt-foundry.yml` must exist at the repo root on that branch.
5. Labels added by the CLI with your own token (for example after `foundry reset`) do fire `issues.labeled`, since it is your token, not the job's. Labels added *inside* a job with the built-in token do not; that is why `restart` and `start` continue in the same job instead.

## `Some specified paths were not resolved, unable to cache dependencies`

The `setup-node` step in the composite action tried to cache npm using a path under `_actions/`, outside the workspace. Fixed in v0.1.34. If you pin an older ref, move to `@main`.

## `Resource not accessible by integration`

The token lacks a permission for that call. See the [permissions table](github-backends.md#permissions-reference). With the built-in token, grant it in the workflow's `permissions:` block. With a GitHub App, add it on the App **and accept the permission update on the installation**; installations keep the old set until an org owner accepts. Check what jobs actually get:

```bash
gh api orgs/YOUR_ORG/installations --jq '.installations[] | select(.app_slug=="YOUR_APP") | .permissions'
```

`Failed to create check run` in the log is this, for `checks: write`. It is a warning, not a failure.

## Two Foundry runs show as cancelled

Foundry's own comments trigger `issue_comment` events. The job `if:` filters them, but a **workflow-level** `concurrency` group admits every run before the filter, and GitHub keeps only one pending run per group, so they cancel each other. A pending human `@foundry` command could be the one cancelled. Declare `concurrency` on the **job**, as the template does.

## The preview comment shows an Actions run URL

Before v0.1.34, a provider `up_command` whose stdout looked like a URL (`gh workflow run` prints one) was taken as the preview URL even when `url_template` was set. Now the template always wins. Upgrade.

## The agent exited immediately, outcome `errored`

Usually authentication. Open the run's transcript artifact (`foundry-issue-<n>-run-<id>`) or the job log and look at the first lines from `claude`. Confirm `CLAUDE_CODE_OAUTH_TOKEN` is set as a secret the repo can see:

```bash
gh api repos/OWNER/REPO/actions/organization-secrets --jq '.secrets[].name'   # org-level
gh secret list --repo OWNER/REPO                                                # repo-level
```

The token is tied to the Claude subscription of whoever ran `claude setup-token`, and it expires; regenerate and update the secret.

## Verification failed

Foundry labels the task `state:failed` and posts each command's result and the failing output on the issue. Fix the cause (often the verify command itself, or a dependency the runner image lacks) and `@foundry restart`, or check the branch out locally and run the commands by hand. A verify-to-agent retry loop is planned; today a failure stops the task.

## `@foundry continue` on a PR comment did nothing

Not yet supported: a comment on the PR carries the PR number, not the issue number. Comment on the issue instead.

## `@foundry stop` did nothing

A running job cannot be stopped by a comment. Press **Cancel** on the run in the Actions UI, then `@foundry restart` or `@foundry start` to fix labels and re-queue.

## The agent asked a question, I answered, and the relaunch had none of its earlier work

Known gap in the first version: when a job ends with the task waiting for input, the agent's partial commits are not yet pushed, and the next job starts from a fresh worktree. Push-before-pause and recreate-worktree-on-resume are the next fixes. Until then, ask the agent (in the issue brief) to commit and push as it goes, or keep tasks small enough that a question does not come mid-implementation.

## Where are the logs?

- The job log is the full agent transcript, streamed live.
- The same transcript (`agent.log`, stream-json) is uploaded as an artifact named `foundry-issue-<n>-run-<id>` when the template's upload step is present.
- On the issue, the status comment records each transition.

## How do I test a Foundry change before merging it?

Point the workflow at a branch: `uses: joyntshops/foundry@your-branch`. Composite actions are built from whatever ref you name. Switch back to `@main` after merging.

## A task is in a bad state and I want to start over

```bash
foundry reset 42            # dry run: shows what it would remove
foundry reset 42 --force    # preview down, close PR, delete branch, state:ready
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
