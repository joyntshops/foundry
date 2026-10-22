# Workflows

Everything on this page is driven from GitHub. Three comments start or stop work, reviews send it back, merges finish it. Each of those is an event, and each event is one Actions job.

## The three commands

Humans act on a task with exactly three comments on its **issue**:

| Command | What it does |
|---|---|
| `@foundry go [message]` | Start the issue if it has never been started. Otherwise proceed from the branch: this is how you answer a question, approve or revise a plan, send a PR back with feedback, or pick a failed task up again. |
| `@foundry restart` | Discard the branch and start the issue over from scratch, in the same job. |
| `@foundry stop` | Stop the agent. The branch stays, the task is marked failed, and `@foundry go` continues it. |

The message can be on the same line as `go` or start on the next line. Multiline messages are fine:

```
@foundry go
Use the tabbed layout.
Also add a test for the empty case.
```

### Comments are context, never triggers

Any other comment on the issue starts nothing. It is not lost: at every launch Foundry writes the issue body and **every human comment so far, in order**, to the file the agent reads first (`FOUNDRY_ISSUE_FILE`). Foundry's own comments are left out. So a thread like this works as you would expect:

```
alice:   Also make the button blue.
bob:     And keep the old one for a week.
alice:   @foundry go
```

The agent is launched once, with all three comments in front of it.

### Labels are status and settings, never commands

Foundry owns the `state:*` labels: exactly one is on a tracked issue at a time, and only Foundry adds or removes them. Adding one by hand does nothing. The labels humans set are *settings*, read when the agent is launched:

| Label | Effect |
|---|---|
| `mode:plan` | The first run produces a plan for approval instead of code. Approve with `@foundry go`, revise with `@foundry go <feedback>`. |
| `mode:default` | Agent runs in step-by-step permission mode |
| `mode:auto` | Agent runs with full permissions (the default when no mode label is present) |
| `agent:*` | Selects a backend via `agent_label_map` |

### Who may command Foundry

Anyone who can comment can type `@foundry go`, and on a public repository that is everyone. Two gates stop a stranger from starting a paid run. The workflow template's `if:` admits comments only from `OWNER`, `MEMBER`, and `COLLABORATOR` authors (`author_association`, checked before a runner starts). Inside the job, Foundry then looks up the commenter's repository permission and requires **write** or **admin**; anything less, or a lookup failure, is logged and ignored.

### Where to comment

- **Issue comments** work for all three commands.
- **PR comments** do not: a comment on the PR carries the PR number, not the issue number, and is ignored. Comment on the issue. Formal reviews with **Request changes** on the PR do work.

## Standard development flow

```
1. Open a GitHub Issue (the template gives the agent a developer-quality brief)
2. Comment @foundry go
3. Foundry claims → creates worktree → launches agent
4. Agent implements the task
5. Foundry verifies (lint/build/test)
6. PR opened → integration; preview up; verify_preview against it
7. Human reviews the PR
8. Approve the PR: Foundry rebases it onto integration, waits for checks, and merges
9. PR integration → main (manual; previewed too, see pull_request_bases)
```

## How PR feedback works

Two ways to send the agent back to work on a PR:

1. **Formal review** — submit a review with "Request changes". Foundry feeds the review body and inline comments to the agent. Bounded by `max_input_rounds`.
2. **`@foundry go <feedback>` on the issue** — explicit, not bounded.

## Changing the task mid-way

**The requirements changed** — edit the issue body (or say so in a comment) and `@foundry go`. Every launch re-reads the body and the whole thread; the agent continues from the branch.

**Start over** — `@foundry restart`. The branch is deleted and the issue is claimed fresh, with whatever labels it now has (add `mode:plan` first if you want a plan this time).

**Stop for now** — `@foundry stop`. Whatever was committed stays on the branch; `@foundry go` continues from it.

## Release flow

```bash
# On integration branch:
foundry release patch   # or minor, major

# Creates version bump commit on integration
# Then manually:
# 1. Create PR: integration → main
# 2. After merge, tag main with the version
```

The `release` command bumps version in ALL files listed in `version_sources`, ensuring unified monorepo versioning.

## Hotfix flow

```bash
# 1. Create hotfix branch from main
git checkout main
git checkout -b hotfix/v1.2.1

# 2. Open an issue and @foundry go (or fix by hand)
# 3. After fix, merge hotfix to main
# 4. Sync integration with production fixes:
foundry sync-integration
```

## Review flow

Approving the PR on GitHub runs this flow automatically (`review.merge_on_approval`, on by default). `foundry review` is the same code from a checkout.

```bash
foundry review 42
```

This:
1. Checks PR mergeability
2. Rebases the feature branch onto integration (linear history)
3. Pushes the updated branch
4. Waits for the PR's checks
5. Merges into integration (rebase method)
6. Runs integration rebuild
7. Completes the task: `state:done`, issue closed, preview down

## Cleanup: `foundry reset`

To undo a task entirely, from any checkout:

```bash
foundry reset 42            # dry run
foundry reset 42 --force    # tear down preview, close PR, delete remote branch, clear the state label
```

The task is rebuilt from the issue's claim comment, so no local state is needed. Comment `@foundry go` to start it again.

## Concurrent tasks

Every issue gets its own job, worktree, feature branch, and agent process. Runs for the same issue are serialised by the workflow's `concurrency` group (a `go` sent while a job is running waits for it); parallelism across issues is bounded only by your GitHub plan's concurrent-job limit.
