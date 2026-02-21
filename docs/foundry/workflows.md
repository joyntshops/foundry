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

## Task Change Handling

### Replan

When requirements change mid-implementation:

1. Update the issue body
2. Comment `@foundry replan` or add label `spec:changed`
3. Foundry pauses the agent, re-reads the issue, and resumes

### Restart

To discard current work and start fresh:

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
