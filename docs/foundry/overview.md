# Overview

Foundry turns GitHub Issues into verified pull requests. It is the **orchestration layer** around a coding agent: it decides when an agent runs, where it runs, what happens to its output, and how a human steers it, all through comments and labels on the issue itself.

Foundry is a GitHub Action. It is not a coding agent, and it is not a server.

## Key concepts

| Concept | Description |
|---------|-------------|
| **Task** | A GitHub Issue that Foundry has claimed. Its lifecycle is a `state:*` label; exactly one is present at any time. |
| **Event** | Something that moves a task: an `@foundry go`, `restart`, or `stop` comment, a review, a merge. Each one starts a job. Labels and plain comments are inputs the agent reads, never triggers. |
| **Job** | One run of the Action for one event. It performs one transition and exits. Nothing persists between jobs except what is on GitHub. |
| **Agent backend** | The CLI command that does the coding. Pluggable; selected by config or by an `agent:*` label. It runs as a subprocess of the job and ends with a typed report. |
| **Verification** | Your lint, typecheck, build, and test commands, run in the worktree. No PR is opened until they pass. |
| **Integration branch** | The branch feature PRs merge into, named per repo (`branches.integration`). It is promoted to the production branch by a PR a human opens. |
| **Preview** | A per-task environment stood up when the PR opens and torn down when it merges, through a command or workflow you own. Optional. |

## What Foundry does

1. **Claims** the issue when a human with write access comments `@foundry go`: `state:in-progress` plus a structured claim comment that is the task's durable record.
2. **Isolates** the work in a git worktree on a feature branch cut from the integration branch.
3. **Launches** the configured agent with the issue body and every human comment on it as its brief.
4. **Reads the agent's report**: done, needs input, plan ready, or blocked. Control flow never reads the agent's prose.
5. **Verifies** the result. Failures are posted back to the issue.
6. **Opens a PR** into the integration branch and labels the issue `state:ready-for-human-review`.
7. **Deploys a preview**, if configured, and posts its URL on the PR.
8. **Listens** for the human. Each `@foundry go`, review, or merge is a new event and a new job: relaunch the agent from the branch with the whole thread, or merge and mark the task `state:done`.

## What Foundry does not do

- **It does not write code.** The agent does. Foundry runs it, gates it, and routes its output.
- **It does not host anything.** Previews are orchestrated by Foundry but deployed by a command or workflow you own.
- **It does not replace CI.** Verification is a pre-PR gate on the agent's branch. Your CI still runs on the PR, and approve-to-merge waits for it.
- **It does not keep state anywhere but GitHub.** A job rebuilds the task from the issue every time. Delete the runner, nothing is lost.

## Architecture

```
GitHub event (comment · review · merge · dispatch · schedule)
        │
        ▼  one Actions job
┌───────────────────────────────────────────────┐
│ foundry action                                │
│   recover task from GitHub                    │
│   map event → FoundryEvent                    │
│   EventHandler: claim · worktree · agent      │
│                 report · verify · PR          │
│                 preview · labels · comments   │
└───────────────────────────────────────────────┘
        │
        ▼
labels · claim comment · status comment · PR · preview comment
                        (the state)
```

Everything a later job needs to know is written to GitHub before the current one exits. The next job reads it back: the claim comment gives branch and backend, the `state:*` label gives status, the PR lookup gives the PR, the preview comment gives the URL.

## Security model

- **Who can start a run.** Only an `@foundry` comment from a user the workflow's `if:` admits (`OWNER`, `MEMBER`, `COLLABORATOR`) starts a job, and the job then checks that the commenter has write or admin permission on the repository before acting. Anyone else's comment is ignored and logged. Labels and plain comments start nothing.
- **What the agent can do.** The agent runs inside your Actions job with the permissions the workflow grants and the secrets the job exposes. This is the same trust boundary as CI: anything your CI could do, the agent can do. Review the backend commands you configure as you would any CI step.
- **Issue text is untrusted input.** Titles and bodies reach the agent's command line. Foundry passes them through environment variables (`FOUNDRY_ISSUE_*`) and a file the agent reads, never by re-evaluating them in a shell. If you write your own backend command, keep it that way.
- **Secrets.** `CLAUDE_CODE_OAUTH_TOKEN` bills the Claude plan of whoever generated it. The GitHub App's private key lets jobs act as the App on the repos it is installed on. Store both as repository or organization secrets; Foundry never writes them anywhere.
- **Verification runs the repo's own commands** in the agent's worktree, so a change to a build script runs during verify. This is true of every CI system and is why merging stays a human action.

Report a vulnerability through the process in [SECURITY.md](../../SECURITY.md).

## Next steps

- [Onboarding](onboarding.md)
- [Writing a task](writing-a-task.md)
- [Workflows](workflows.md): steering the agent from the issue
- [GitHub Action](github-action.md): the decisions behind the design
