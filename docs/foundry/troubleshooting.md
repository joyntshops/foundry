# Troubleshooting

Two sections: one for the GitHub Action, one for the always-on runner. Start with the one you run.

## GitHub Action

Everything below was hit on real runs. Fixes are in the version noted where relevant.

### Nothing happened after I added `state:ready`

1. The workflow must be on the **default branch**. `issues` and `issue_comment` events only trigger workflows from there.
2. The label must be exactly what `.joynt-foundry.yml` says under `labels.ready` (default `state:ready`).
3. Check Actions → Foundry. A run marked **skipped** means the job's `if:` filtered the event; that is expected for labels Foundry adds itself.
4. Check that `.joynt-foundry.yml` exists at the repo root on that branch.

### `Some specified paths were not resolved, unable to cache dependencies`

The `setup-node` step in the composite action tried to cache npm using a path under `_actions/`, outside the workspace. Fixed in v0.1.34. If you pin an older ref, move to `@main`.

### `Resource not accessible by integration`

The token lacks a permission for that call. Which one depends on the call:

| Call | Needs |
|---|---|
| labels, comments | `issues: write` |
| open PR, PR comments | `pull-requests: write` |
| push | `contents: write` |
| `gh workflow run` (preview up/down) | `actions: write` |
| deployment records | `deployments: write` |
| check run for verification results | `checks: write` (non-fatal warning without it) |

With the built-in token, grant these in the workflow's `permissions:` block. With a GitHub App, add them on the App **and accept the permission update on the installation**. Changing the App only creates a request; installations keep the old set until an org owner accepts it. Check what jobs actually get:

```bash
gh api orgs/YOUR_ORG/installations --jq '.installations[] | select(.app_slug=="YOUR_APP") | .permissions'
```

### Two Foundry runs show as cancelled

Foundry's own comments trigger `issue_comment` events. The job `if:` filters them, but a **workflow-level** `concurrency` group admits every run before the filter, and GitHub keeps only one pending run per group, so they cancel each other. A pending human `@foundry` command could be the one cancelled. Declare `concurrency` on the **job**, as the template does.

### The preview comment shows an Actions run URL

Before v0.1.34, a provider `up_command` whose stdout looked like a URL (`gh workflow run` prints one) was taken as the preview URL even when `url_template` was set. Now the template always wins. Upgrade.

### The agent exited immediately, outcome `errored`

Usually authentication. Open the run's transcript artifact (`foundry-issue-<n>-run-<id>`) or the job log and look at the first lines from `claude`. Confirm `CLAUDE_CODE_OAUTH_TOKEN` is set as a secret the repo can see:

```bash
gh api repos/OWNER/REPO/actions/organization-secrets --jq '.secrets[].name'   # org-level
gh secret list --repo OWNER/REPO                                                # repo-level
```

The token is tied to the Claude subscription of whoever ran `claude setup-token`, and it expires; regenerate and update the secret.

### `@foundry continue` on a PR comment did nothing

Not yet supported: a comment on the PR carries the PR number, not the issue number. Comment on the issue instead.

### `@foundry stop` did nothing

A running job cannot be stopped by a comment. Press **Cancel** on the run in the Actions UI, then `@foundry restart` or `@foundry start` to fix labels and re-queue.

### Where are the logs?

- The job log is the full agent transcript, streamed live.
- The same transcript (`agent.log`, stream-json) is uploaded as an artifact named `foundry-issue-<n>-run-<id>` when the template's upload step is present.
- On the issue, the status comment records each transition.

### How do I test a Foundry change before merging it?

Point the workflow at a branch: `uses: joyntshops/foundry@your-branch`. Composite actions are built from whatever ref you name. Switch back to `@main` after merging.

## Always-on runner

### "No .joynt-foundry.yml found"

Run `foundry init` in the repo root, or run Foundry from inside the repo.

### Claims are not happening

1. `gh auth status`, or check the GitHub App credentials under `~/.joynt-foundry/`.
2. The repo needs Foundry's labels (`foundry init` creates them).
3. Issues must be open and labeled `state:ready`.
4. `foundry status` for capacity (`max_sessions`).

Two runners racing is handled by the claim protocol; the loser skips the task on its next poll.

### tmux session not found

```bash
tmux list-sessions
foundry sessions
```

`foundry run` reconciles on startup and marks dead sessions stopped. `foundry prune --all` removes stale local state.

### Agent not launching

1. Check the backend command in `.joynt-foundry.yml`.
2. `foundry attach <issue>` to see the session.
3. Logs are at `~/.joynt-foundry/logs/<org>__<repo>/<issue>/agent.log`.

### Verification failed

Foundry marks the task `state:failed` and posts the failing command's output on the issue. To debug, `cd` into the worktree (path in `foundry status`), run the verify commands by hand, then `@foundry restart`.

### Worktree conflicts

```bash
git worktree list
git worktree remove /path/to/worktree --force
foundry prune --all
```

### PR creation failed

- `integration` must exist on the remote.
- The feature branch must be pushed.
- The identity Foundry uses needs write access.

### Release or sync-integration errors

`foundry release` must run on `integration` with `version_sources` configured and valid. If `foundry sync-integration` hits conflicts:

```bash
git checkout integration
git merge origin/main
# resolve, then
git add . && git commit && git push
```

### Local state

```
~/.joynt-foundry/
├── runner-id
├── state-<org>__<repo>.json
├── github-app-<org>.json / .pem
├── logs/<org>__<repo>/<issue>/agent.log
└── tasks/<org>__<repo>/<issue>/
```

`rm -rf ~/.joynt-foundry/` resets everything, including App credentials.

### Debug output

```bash
foundry --verbose run
```
