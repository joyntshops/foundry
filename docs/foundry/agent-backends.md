# Agent Backends

Foundry is **not coupled to any specific coding agent**. It uses a pluggable backend system that launches a configured CLI command through a *worker*: a subprocess of the job under the GitHub Action, or a tmux session under the always-on runner.

## How It Works

1. Foundry claims a task and creates a git worktree
2. Foundry resolves the agent backend (from config or an `agent:*` issue label)
3. Foundry launches the backend's command in the worktree via the worker
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
| `{session_id}` | (resume_command only) session id parsed from the previous transcript | `abc123` |
| `{prompt}` | (resume_command only) the human's message, single-quote escaped | `Please add tests` |

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

### Resuming (`resume_command`)

A backend may define `resume_command`, used when a human replies to an agent question or requests changes on the PR. It gets `{session_id}` from the previous transcript and `{prompt}` from the human. **Under the GitHub Action this is not used**: the session store lives on the runner that started the session, and that runner is gone by the time the reply arrives, so the agent is relaunched with the message and the issue as context instead. Under the always-on runner it resumes the live session.

## Logging

All backends should tee output to `{log_dir}/agent.log`. Foundry creates the log directory automatically, parses this file to classify the outcome (Claude Code's stream-json format is understood natively), and under the Action streams it to the job log and can upload it as an artifact.

## Authentication under the Action

The job passes `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from its inputs into the agent's environment. Claude Code reads either directly. Other agents need their own credentials passed the same way; use `env:` on the backend with a secret exposed to the job.

## Lifecycle

1. **Launch**: the worker starts the command in the worktree
2. **Running**: the agent works autonomously. Runner: `foundry attach` to watch. Action: the job log.
3. **Exit**: the agent process exits
4. **Detection**: runner polls the worker; the Action waits on the subprocess
5. **Classification**: `agent.log` is parsed for completion, needs-input, plan, or error
6. **Verification**: Foundry runs the configured verify pipeline
