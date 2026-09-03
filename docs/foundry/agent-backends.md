# Agent Backends

Foundry is **not coupled to any specific coding agent**. It uses a pluggable backend system that launches a configured CLI command as a subprocess of the job. The job log is the agent's transcript.

## How It Works

1. Foundry claims a task and creates a git worktree
2. Foundry resolves the agent backend (from config or an `agent:*` issue label)
3. Foundry launches the backend's command in the worktree
4. The agent runs until it exits
5. Foundry classifies the outcome from the transcript and runs verification

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
| `{permission_mode}` | Claude Code flag derived from the issue's `mode:*` label | `--dangerously-skip-permissions`, `--permission-mode plan` |

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

### When a human replies

When a human answers an agent question, approves a plan, or requests changes on the PR, the agent is **relaunched** with the message as `{body}` and the issue as context. There is no session resume: the session store lived in the job that asked, and that job is gone. Write the backend command so the agent re-reads the branch and the issue thread on every launch; Claude Code does this by default when pointed at `{issue_url}`.

## Logging

All backends should tee output to `{log_dir}/agent.log`. Foundry creates the log directory, parses this file to classify the outcome (Claude Code's stream-json format is understood natively), streams it to the job log, and the workflow template uploads it as an artifact.

## Authentication

The job passes `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from its inputs into the agent's environment. Claude Code reads either directly. Other agents need their own credentials passed the same way; use `env:` on the backend with a secret exposed to the job.

## Lifecycle

1. **Launch**: the command starts in the worktree as a subprocess of the job
2. **Running**: the agent works autonomously; watch the job log
3. **Exit**: the agent process exits; the job was waiting on it
4. **Classification**: `agent.log` is parsed for completion, needs-input, plan, or error
5. **Verification**: Foundry runs the configured verify pipeline
