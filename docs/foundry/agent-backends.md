# Agent Backends

Foundry is **not coupled to any specific coding agent**. It uses a pluggable backend system that launches a configured CLI command as a subprocess of the job. The job log is the agent's transcript.

## How It Works

1. Foundry claims a task and creates a git worktree
2. Foundry resolves the agent backend (from config or an `agent:*` issue label)
3. Foundry launches the backend's command in the worktree
4. The agent runs until it exits, and submits a **report**
5. Foundry branches on the report's `status`, checked against facts it can see itself (did the run error, are there commits), then runs verification

## The agent report

Foundry never reads an agent's prose to decide what happens next. The agent ends its run with a typed report:

| Field | |
|---|---|
| `status` | `done` · `needs_input` · `plan_ready` · `blocked` |
| `summary` | What was done or why it stopped. Becomes the PR description. |
| `assumptions[]` | Decisions made without asking. Listed in the PR for the reviewer. |
| `questions[]` | For `needs_input`: `question`, optional `options[{label, description}]`, optional `multi_select`. |
| `plan` | For `plan_ready`: the plan in Markdown. |

What Foundry does with it:

| Evidence | Transition |
|---|---|
| The run itself failed (`is_error`, non-`success` subtype) | `state:failed` |
| No report, or an invalid one | `state:failed`, with the reason. Foundry fails closed; it never guesses. |
| `needs_input` | questions posted, `state:waiting-for-input` (even if commits exist: partial work is not completion) |
| `plan_ready`, or `done` in plan mode | plan posted, `state:plan-review` |
| `blocked` | `state:failed`, summary posted |
| `done` but no commits beyond the base | `state:failed`: a contradiction |
| `done` with commits | verify → PR |

Two transports feed the same report:

- **Structured output (Claude Code).** Every launch has `FOUNDRY_REPORT_SCHEMA` in its environment. Passing `--json-schema "$FOUNDRY_REPORT_SCHEMA"` makes Claude Code validate the report itself and attach it to the final `result` event. The preset does this.
- **`foundry report` (anything else).** The agent runs it before exiting; it validates, writes `$FOUNDRY_REPORT_FILE`, and exits non-zero with a precise message on bad input so the agent can retry:

```bash
foundry report --status needs_input --summary "Two layouts are possible." \
  --question "Which layout? | Tabs; Single form"
```

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
    preset: claude-code
```

The preset expands to:

```
claude {permission_mode} -p "You are working on issue #{issue_number}: $FOUNDRY_ISSUE_TITLE. …"
  --json-schema "$FOUNDRY_REPORT_SCHEMA" --disallowedTools AskUserQuestion
  --verbose --output-format stream-json < /dev/null 2>&1 | tee {log_dir}/agent.log
```

`AskUserQuestion` is disallowed because nobody is there to answer it; questions go in the report. `< /dev/null` stops the CLI waiting three seconds for stdin.

### What the preset tells the agent

Three environment variables shape every launch. `FOUNDRY_ISSUE_FILE` is a Markdown file holding the issue's title, URL, and body; the preset tells the agent to read it first, so the brief arrives even when the agent has no network (Claude Code's plan mode blocks `gh`, `curl`, and web fetches; the first real plan-mode run planned from the title alone). `FOUNDRY_AGENT_BRIEF` is appended to the system prompt: the standing instruction a stakeholder gives a developer (read the whole issue, decide small things yourself and list them as assumptions, ask only material questions with options, change only what is needed, commit as you go, never push or open PRs, run the verify commands, report truthfully). `FOUNDRY_RESUME_CONTEXT` is empty on a first launch and, on a relaunch after a human reply, says what the agent asked, what the human answered, and that the branch already holds its earlier commits. A custom command can use both the same way.

### Untrusted text in commands

Issue titles and bodies are written by whoever opened the issue and end up on a shell command line. Every launch gets `FOUNDRY_ISSUE_TITLE`, `FOUNDRY_ISSUE_BODY`, `FOUNDRY_ISSUE_NUMBER`, and `FOUNDRY_ISSUE_URL` in its environment; `"$FOUNDRY_ISSUE_TITLE"` is never re-evaluated by the shell, so prefer it. `{title}` and `{body}` still work and are escaped for use **inside double quotes only**.

### Multiple Backends

```yaml
default_agent_backend: claude-code

agent_backends:
  claude-code:
    type: command
    preset: claude-code

  cursor:
    type: command
    command: >-
      cursor --headless --task "Implement: {title}" --context {issue_url}
      2>&1 | tee {log_dir}/agent.log

  aider:
    type: command
    command: >-
      aider --yes --message "Implement issue #{issue_number}: $FOUNDRY_ISSUE_TITLE. See {issue_url}. When you stop, run foundry report."
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
