# Agent Backends

Foundry is **not coupled to any specific coding agent**. It uses a pluggable backend system that launches a configured CLI command inside a tmux session.

## How It Works

1. Foundry claims a task and creates a git worktree
2. Foundry creates a tmux session in that worktree
3. Foundry resolves the agent backend (from config or issue labels)
4. Foundry sends the backend's command to the tmux session
5. The agent runs inside tmux until it exits
6. Foundry detects exit and runs verification

## Backend Types

### `command` (the only type in v1)

Runs an arbitrary shell command with template variable interpolation.

## Template Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{worktree}` | Absolute path to the git worktree | `/path/to/wts/42-add-login` |
| `{issue_url}` | Full GitHub issue URL | `https://github.com/org/repo/issues/42` |
| `{issue_number}` | Issue number | `42` |
| `{repo}` | GitHub repo identifier | `org/repo` |
| `{title}` | Issue title | `Add login page` |
| `{body}` | Issue body (truncated to 4000 chars) | `## Requirements...` |
| `{log_dir}` | Path to log directory for this task | `~/.joynt-foundry/logs/org__repo/42` |
| `{state_dir}` | Path to state directory for this task | `~/.joynt-foundry/tasks/org__repo/42` |

## Configuration

### Basic Setup

```yaml
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

### Multiple Backends

```yaml
default_agent_backend: claude-code

agent_backends:
  claude-code:
    type: command
    command: >-
      claude --dangerously-skip-permissions
      -p "Implement issue #{issue_number}: {title}. Issue: {issue_url}"
      2>&1 | tee {log_dir}/agent.log

  cursor:
    type: command
    command: >-
      cursor --headless --task "Implement: {title}" --context {issue_url}
      2>&1 | tee {log_dir}/agent.log

  aider:
    type: command
    command: >-
      aider --yes --message "Implement issue #{issue_number}: {title}. See {issue_url}"
      2>&1 | tee {log_dir}/agent.log
    env:
      AIDER_MODEL: claude-3-5-sonnet-20241022

  custom:
    type: command
    command: ./scripts/my-agent.sh {worktree} {issue_url} {issue_number}
```

### Per-Task Backend Selection via Labels

Map issue labels to specific backends:

```yaml
agent_label_map:
  "agent:claude": claude-code
  "agent:cursor": cursor
  "agent:aider": aider
```

When an issue has the label `agent:claude`, Foundry uses the `claude-code` backend. If no matching label is found, the `default_agent_backend` is used.

### Environment Variables

Backends can set environment variables:

```yaml
agent_backends:
  my-agent:
    type: command
    command: my-agent --issue {issue_url}
    env:
      MY_AGENT_TOKEN: "xxx"
      MY_AGENT_LOG: "{log_dir}/output.log"
```

Env values also support template variable interpolation.

## Adding a New Backend

To add support for a new coding agent:

1. Add a new entry under `agent_backends` in `.joynt-foundry.yml`
2. Set `type: command`
3. Set `command` to the CLI invocation with template variables
4. Optionally add `env` for environment variables
5. Optionally map a label in `agent_label_map`

No code changes to Foundry are needed. The command backend is fully generic.

## Logging

All backends should tee output to `{log_dir}/agent.log` for debugging. Foundry creates the log directory automatically.

## Lifecycle

1. **Launch**: Command is sent to the tmux session
2. **Running**: Agent works autonomously; user can `foundry attach` to observe
3. **Exit**: Agent process exits (success or failure)
4. **Detection**: Foundry detects the tmux session has no running process
5. **Verification**: Foundry runs the configured verify pipeline
