# Onboarding

Get a repo set up with Foundry in 5 minutes.

## 1. Initialize

```bash
cd your-repo
foundry init
```

This creates `.joynt-foundry.yml`, sets up GitHub labels, and creates the `integration` branch.

Foundry auto-detects your project type (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and populates sensible defaults for `verify`, `integration_rebuild`, and `version_sources`. If the repo has zero commits, Foundry creates an initial commit automatically so the integration branch can be set up.

## 2. Configure

Edit `.joynt-foundry.yml`:

```yaml
repo: your-org/your-repo

# List ALL version files that share a unified version
# Supported: package.json, Cargo.toml, pyproject.toml
version_sources:
  - package.json
  - packages/api/package.json
  - packages/web/package.json

# Verify commands to run before opening PRs (auto-detected from project type)
verify:
  - npm run lint
  - npm run typecheck
  - npm run build
  - npm test

# Agent backend configuration
default_agent_backend: claude-code
agent_backends:
  claude-code:
    type: command
    command: >-
      claude --dangerously-skip-permissions
      -p "You are working on issue #{issue_number}: {title}.
      The issue is at {issue_url}. Read the issue body and implement the task.
      When done, create a commit with your changes."
      --output-format stream-json 2>&1 | tee {log_dir}/agent.log
```

## 3. Create a Task

Create a GitHub Issue and add the label `state:ready`.

## 4. Run Foundry

```bash
foundry run
```

Foundry will claim the issue, create a worktree, launch the agent, verify the output, and open a PR.

## 5. Monitor

```bash
# In another terminal:
foundry status          # overview
foundry sessions        # tmux sessions
foundry attach 42       # attach to issue #42's session
```

## Stopping

```bash
foundry stop 42         # stop a specific task
# Or Ctrl+C the foundry run process
```
