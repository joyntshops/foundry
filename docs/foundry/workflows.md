# Workflows

## Standard Development Flow

```
1. Create GitHub Issue
2. Label: state:ready
3. foundry run claims → creates worktree → launches agent
4. Agent implements task
5. Foundry verifies (lint/build/test)
6. PR opened → integration
7. Human reviews PR
8. foundry review <pr> merges into integration
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

## Controlling Foundry

Comment `@foundry <command>` on an issue or PR to control the agent. Foundry checks for commands on every poll cycle.

### Command Reference

| Command | Valid when | What it does |
|---------|-----------|--------------|
| `@foundry stop` | Agent running, waiting for input | Kill the agent and mark task failed |
| `@foundry restart` | Agent running, waiting, failed, plan review | Discard all work (worktree + branch) and re-queue the issue as ready |
| `@foundry replan` | Agent running | Kill the agent, re-read the issue body, and relaunch |
| `@foundry plan [message]` | Agent running, waiting, plan review | Relaunch in plan mode (produces a plan for review) |
| `@foundry continue [message]` | PR open, waiting for input, plan review | Resume the agent with the message as context |
| `@foundry start [message]` | Failed, stopped | Clean up and re-queue the issue with optional context |

The `[message]` is optional for all commands that accept it. It can appear on the same line as the command or start on the next line. Multiline messages are supported:

```
@foundry continue
Please fix the typo on line 5.
Also add a test for the edge case where the input is empty.
```

### Where to comment

- **Issue comments** — always work for any command
- **PR comments** — work once a PR exists (Foundry checks the PR when `task.pr_number` is set)

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

## Concurrent Sessions

Foundry supports multiple tasks in parallel (default: 4). Each task gets its own:
- Git worktree
- Feature branch
- tmux session
- Agent process

Configure `max_sessions` in `.joynt-foundry.yml` to match your machine's capacity.
