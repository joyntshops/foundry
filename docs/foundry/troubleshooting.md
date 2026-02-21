# Troubleshooting

## Common Issues

### "No .joynt-foundry.yml found"

Run `foundry init` in your repo root, or check that you're running foundry from within the repo directory.

### Claim Failures

If tasks aren't being claimed:

1. Check `gh auth status` — ensure you're authenticated
2. Check the repo has the required labels (`foundry init` creates them)
3. Check issues are labeled `state:ready` and are open
4. Check `foundry status` for capacity (`max_sessions`)

If two runners race to claim:
- This is handled by the claim protocol (comment-based verification)
- The loser silently skips the task on the next poll

### tmux Session Not Found

```bash
# List all tmux sessions
tmux list-sessions

# List Foundry sessions specifically
foundry sessions
```

If a session died unexpectedly:
- `foundry run` reconciles on startup (marks dead sessions as stopped)
- `foundry prune --force` cleans up stale state

### Agent Not Launching

1. Check the backend command in `.joynt-foundry.yml`
2. Attach to the tmux session to see errors: `foundry attach <issue>`
3. Check logs at `~/.joynt-foundry/logs/<repo>/<issue>/`

### Verification Failures

When verification fails, Foundry:
- Marks the task as `failed`
- Posts a comment on the issue with failure details

To debug:
1. `cd` into the worktree: check `foundry status` for the path
2. Run verify commands manually
3. Fix and re-run, or `@foundry restart` the task

### Worktree Conflicts

If a worktree already exists:

```bash
# List worktrees
git worktree list

# Remove a stale worktree
git worktree remove /path/to/worktree --force

# Or use Foundry's prune
foundry prune --force
```

### PR Creation Fails

Check:
- The `integration` branch exists on the remote
- The feature branch has been pushed
- You have write access to the repo
- `gh pr create` works manually

### Release Command Errors

- Must be on `integration` branch
- `version_sources` must be configured and files must exist
- All package.json files must have valid `version` fields

### Sync Integration Merge Conflicts

If `foundry sync-integration` fails:

```bash
git checkout integration
git merge origin/main
# Resolve conflicts
git add .
git commit
git push
```

## Local State

Foundry stores state in `~/.joynt-foundry/`:

```
~/.joynt-foundry/
├── runner-id              # Unique runner identifier
├── state-org__repo.json   # Task state per repo
├── logs/
│   └── org__repo/
│       └── 42/            # Logs per task
│           └── agent.log
└── tasks/
    └── org__repo/
        └── 42/            # Task state dir
```

To reset state completely:

```bash
rm -rf ~/.joynt-foundry/
```

## Debug Mode

```bash
foundry --verbose run
foundry --verbose status
```

Verbose mode shows debug-level log messages including poll timing and state transitions.
