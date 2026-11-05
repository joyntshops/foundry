# Design notes

The non-obvious decisions behind how Foundry runs, recorded so they are not rediscovered. This page is for whoever changes Foundry next, human or agent; a user of Foundry needs none of it, and the user-facing account of the same machinery is [GitHub Action](../github-action.md). Larger decisions that changed Foundry's shape have their own [records](decisions/README.md).

## Decisions and gotchas

**The config and the workflow come from the branch the job checks out.** For `issue_comment`, `schedule`, and `workflow_dispatch` without `--ref`, that is the default branch; the worktree is then created from `origin/<branches.integration>`, which may be a different branch. So on a repo that promotes `test` to `main`, a change to `.joynt-foundry.yml` (the model, verify commands, previews) governs comment-triggered runs only once it reaches `main`, while `gh workflow run foundry.yml --ref test` reads it immediately. `pull_request` and `pull_request_review` events run from the PR's head, which is why a promotion PR exercises the workflow on `test` before anything is merged.

**Nothing Foundry does may depend on triggering another run.** Events caused by the job's built-in token do not start workflow runs, with two exceptions: `workflow_dispatch` and `repository_dispatch`. Preview up/down use `gh workflow run`, which is `workflow_dispatch`, so they are fine. Merges are done by humans, so `pull_request.closed` fires. `@foundry restart` discards the task and starts it again inside the same job rather than putting a label back and hoping. Design any new transition the same way: finish it in-job, or make it a dispatch.

**No branching on prose.** What happens after the agent exits is decided from facts Foundry can check (run error, commits) and the agent's typed report (`done`, `needs_input`, `plan_ready`, `blocked`), submitted as Claude Code structured output or via `foundry report`. Contradictions and missing reports fail closed. The regex heuristics this replaced misread "I have not completed this" as completion and treated "can't tell" as success. Details in [Agent Backends](../agent-backends.md#the-agent-report).

**Approval is the merge button.** The user-facing account is in [GitHub Action](../github-action.md#approval-and-merge). Two details live only here: the rebase is pushed with `--force-with-lease`, and the job's own check (`GITHUB_JOB`) is ignored while waiting for the PR's checks, since it is never finished while it looks at itself. `foundry review` from a checkout runs the same code path.

**Stale PRs are handled from the merge, never from reviews.** When a PR merges into `integration`, the same job lists the other open Foundry PRs into that base, waits for GitHub to recompute mergeability, and for each one that now conflicts dispatches the workflow with a `continue` command carrying a rebase instruction. `workflow_dispatch` is used because it is one of the two event types GitHub delivers even when the job's own token caused it, and the dispatched job runs under the conflicting issue's own concurrency group. Reviews cannot do this: GitHub does not run `pull_request_review` workflows for a PR that has conflicts.

**Relaunch pushes use `--force-with-lease`.** An agent sent back to a branch may rebase. The lease is the remote-tracking ref the job fetched when it recreated the worktree, so a push by anyone else in the meantime is still refused.

**Consecutive transitions happen inside one job.** Claim → agent → verify → PR → preview-up is a single run. A new job is only needed when a human acts. This keeps runner spin-ups to one per human interaction.

**Concurrency groups replace the claim race.** `concurrency.group: foundry-<issue>` makes GitHub serialise runs per issue. The claim protocol's one-second sleep and read-back were written for two runners racing to claim; here that cannot happen. The structured claim comment is kept as the audit record and as the source for task recovery.

**Declare concurrency on the job, not the workflow.** GitHub keeps at most one *pending* run per group and cancels the rest. A workflow-level group admits every triggered run before the job `if:` is evaluated, so Foundry's own comments and labels (filtered out by `if:`) still enter the group, queue behind the active run, and cancel each other. A pending human `@foundry` command could be the one cancelled. Job-level concurrency is evaluated only for jobs that pass `if:`. Seen on the first real run as two "cancelled" Foundry runs.

**Task state is rebuilt from GitHub every run.** The file store under `~/.joynt-foundry/` is empty in every fresh job. `lib/task-recovery.ts` reconstructs a `TaskState` from the latest claim comment (`<!-- foundry-claim-block -->`), the issue's current `state:*` label, the PR for the branch, and the preview comment (`<!-- foundry-preview -->`). This is why the single-state-label invariant (`setStateLabel`) is load-bearing: recovery reads the label to learn the status.

**There is no session resume; there is a hand-off.** `claude --resume` would need the session file from the job that asked, and that job is gone. Instead: when a job ends with the agent waiting (question or plan), Foundry commits anything uncommitted and pushes the branch. When the human answers, the next job recreates the worktree from that branch and relaunches the agent with `FOUNDRY_RESUME_CONTEXT` set to "you stopped because X; the human replied Y; continue from the branch, do not start over". The preset's prompt includes that variable. The human replies with `@foundry go <answer>`; a plain reply is context for the next launch and starts nothing.

**Stopping a run.** `@foundry stop` works: the template sets `cancel-in-progress` for that comment, so GitHub cancels the issue's running job, the action's `if: cancelled()` step marks the task failed, and the stop command's own job tears the preview down. Cancel from the Actions UI has the same effect through the same cleanup step. Either way the issue never stays at `state:in-progress` with nothing running.

**Runs that die silently are reconciled.** A runner failure or the six-hour limit can end a job with no cleanup. The `schedule` trigger (the template's default is every six hours) runs `foundry reconcile`: any `state:in-progress` issue whose status comment is older than `reconcile_stale_minutes` (default 120) is marked failed with a note. Set the threshold above your job `timeout-minutes`.

**Package managers pinned through corepack are enabled.** A repo with `packageManager` in `package.json` (Yarn 2+, pnpm) expects corepack to supply that version, and the runner image ships Yarn 1 with corepack disabled. The action runs `corepack enable` when the field is present, before the agent starts, so both the agent and the verify commands get the pinned manager. A repo that commits its Yarn release (`yarnPath` in `.yarnrc.yml`) never needed this. The first repo that relied on corepack failed every verify on `yarn install` in 150 ms with no output.

**The verification check run is created after the push.** GitHub rejects a check run for a commit it has not seen, so Foundry pushes the branch first and then records one completed check run, success or failure, with the step summary. There is no in-progress check run while verification runs.

**Cost is visible per issue.** The status comment's `Last run` row shows the cost, turns, and duration the agent CLI reported. `agent_max_turns` (default 150) caps a runaway session; the preset passes it as `--max-turns`.

**The Claude Code version is pinned** in `action.yml` (`claude-code-version`). Four CLI behaviours surprised us on the first day; a release should not change Foundry under you. Bump deliberately, or pass `latest`.

**The `if:` filter matters for cost and for safety.** Every `issue_comment` event, including Foundry's own status comments, would otherwise start a runner that does ~40 seconds of setup and exits. The filter in the template starts a job only for `@foundry` comments on issues from `OWNER`/`MEMBER`/`COLLABORATOR` authors, PR events on listed bases or merges, reviews, dispatches, and the schedule. `author_association` is on the comment payload, so it costs nothing to check; it is coarse (a `MEMBER` may have read access only), which is why the job then asks the API for the commenter's actual permission and requires write.

**Who may start a run is Foundry's to decide, not GitHub's.** A GitHub App's permissions govern what the App may do to the repo, not who may address it; the event that starts a job is a comment, and anyone who can see the issue can comment. There is no native "only these users may invoke this App" setting. Interaction limits and conversation locks exist but are blunt. The two gates above are the mechanism.

**Stacked PRs only retarget if the base branch is deleted.** A PR stacked on a feature branch merged into that branch instead of `main` because the feature branch was kept at merge time. Merge with "Delete branch" or expect to open a follow-up PR.

Symptoms and fixes from real runs are collected in [Troubleshooting](../troubleshooting.md).


## Local dry run

```bash
cd path/to/target-repo   # where .joynt-foundry.yml lives
node path/to/foundry/packages/foundry/dist/cli.js action \
  --event-name issues --event-path ./some-payload.json
```

Any payload that maps to no Foundry event (a non-state label, an unmerged PR close) exits 0 after task recovery, which makes for a cheap read-only check that auth and config are wired.
