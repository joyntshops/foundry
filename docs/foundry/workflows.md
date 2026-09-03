# Workflows

Everything on this page is driven from GitHub: labels start work, comments steer it, reviews send it back, merges finish it. Each of those is an event, and each event is one Actions job.

## Standard Development Flow

```
1. Create GitHub Issue
2. Label: state:ready
3. Foundry claims → creates worktree → launches agent
4. Agent implements task
5. Foundry verifies (lint/build/test)
6. PR opened → integration
7. Human reviews PR
8. Approve and merge the PR into integration (foundry review <pr> from a runner rebases first)
9. PR integration → test (manual)
10. PR integration → main (manual)
```

## Release Flow

```bash
# On integration branch:
foundry release patch   # or minor, major

# Creates version bump commit on integration
# Then manually:
# 1. Create PR: integration → main
# 2. After merge, tag main with the version
```

The `release` command bumps version in ALL files listed in `version_sources`, ensuring unified monorepo versioning.

## Hotfix Flow

```bash
# 1. Create hotfix branch from main
git checkout main
git checkout -b hotfix/v1.2.1

# 2. Create issue, label state:ready (or fix manually)
# 3. After fix, merge hotfix to test and main
# 4. Sync integration with production fixes:
foundry sync-integration
```

## Claim-Only Workflow

The claim-only workflow lets you have Foundry claim and set up an issue (worktree, branch) **without** launching an agent. You then direct the agent step-by-step via comment commands.

```
1. Create GitHub Issue
2. Label: state:claim
3. Foundry claims → creates the branch → does NOT start an agent
4. Direct the agent via comments:
   - @foundry plan [message]     → launch in plan mode
   - @foundry continue [message] → launch normally
   - @foundry stop               → cancel and mark failed
   - @foundry restart             → discard and re-queue
```

This is useful when you want to:
- Review the issue setup before starting the agent
- Give the agent specific first instructions via `@foundry continue`
- Start in plan mode via `@foundry plan` and review before implementation

A claimed task costs nothing until you start it; the claim comment records it on the issue.

## Controlling Foundry

Comment `@foundry <command>` on an issue to control the agent. Each comment is an event and starts a job.

### Command Reference

| Command | Valid when | What it does |
|---------|-----------|--------------|
| `@foundry stop` | Waiting for input, plan review, claimed | Mark the task failed. A running job cannot be stopped by a comment; cancel it in the Actions UI. |
| `@foundry restart` | Agent running, waiting, failed, plan review, claimed | Discard all work (worktree + branch) and re-queue the issue as ready |
| `@foundry replan` | Agent running | Kill the agent, re-read the issue body, and relaunch |
| `@foundry plan [message]` | Agent running, waiting, plan review, claimed | Relaunch in plan mode (produces a plan for review) |
| `@foundry continue [message]` | PR open, waiting for input, plan review, claimed | Resume/launch the agent with the message as context |
| `@foundry start [message]` | Failed, stopped, claimed | Clean up and re-queue the issue with optional context |

The `[message]` is optional for all commands that accept it. It can appear on the same line as the command or start on the next line. Multiline messages are supported:

```
@foundry continue
Please fix the typo on line 5.
Also add a test for the edge case where the input is empty.
```

### Where to comment

- **Issue comments** — always work for any command
- **PR comments** — not yet: a PR comment carries the PR number rather than the issue number. Comment on the issue instead. Formal reviews with **Request changes** on the PR do work.

### How PR feedback works

Two ways to send the agent back to work on a PR:

1. **Formal review** — Submit a review with "Request changes". Foundry picks up the review body and inline comments automatically.
2. **`@foundry continue [feedback]`** — Leave a regular PR comment. This is explicit and avoids false triggers from reviewer chatter.

### Task change handling

**Replan** — When requirements change mid-implementation:

1. Update the issue body
2. Comment `@foundry replan`
3. Foundry kills the agent, re-reads the issue, and relaunches

**Restart** — To discard current work and start fresh:

1. Comment `@foundry restart`
2. Foundry stops the agent, removes the worktree, and re-creates from scratch

## Review Flow

`foundry review` is a CLI command run from a checkout with the `integration` branch available. Triggering it automatically on PR approval is planned.

```bash
foundry review 42
```

This:
1. Checks PR mergeability
2. Rebases the feature branch onto integration (linear history)
3. Pushes the updated branch
4. Merges into integration
5. Runs integration rebuild
6. Labels the issue `state:ready-for-human-review`

## Cleanup: `foundry reset`

To undo a task entirely, from any checkout:

```bash
foundry reset 42            # dry run
foundry reset 42 --force    # tear down preview, close PR, delete remote branch, state:ready
```

The task is rebuilt from the issue's claim comment, so no local state is needed. There is nothing to prune: jobs leave nothing behind on a machine.

## Concurrent Tasks

Every issue gets its own job, worktree, feature branch, and agent process. Runs for the same issue are serialised by the workflow's `concurrency` group; parallelism across issues is bounded only by your GitHub plan's concurrent-job limit.
