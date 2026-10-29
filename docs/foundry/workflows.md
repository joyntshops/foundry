# Workflows

Everything on this page is driven from GitHub. Three comments start or stop work, reviews send it back, approvals merge it. Each of those is an event, and each event is one Actions job.

`integration` and `main` throughout mean the branches named under `branches:` in `.joynt-foundry.yml`; a repo keeps whatever names it deploys from.

## The three commands

Humans act on a task with exactly three comments on its **issue**:

| Command | What it does |
|---|---|
| `@foundry go [message]` | Start the issue if it has never been started. Otherwise proceed from the branch: this is how you answer a question, approve or revise a plan, send a PR back with feedback, or pick a failed task up again. |
| `@foundry restart` | Discard the branch and start the issue over from scratch, in the same job. |
| `@foundry stop` | Stop the agent. The branch stays, the task is marked failed, and `@foundry go` continues it. |

The message can be on the same line as `go` or start on the next line. Multiline messages are fine:

```
@foundry go
Use the tabbed layout.
Also add a test for the empty case.
```

### Comments are context, never triggers

Any other comment on the issue starts nothing. It is not lost: at every launch Foundry writes the issue body and **every human comment so far, in order**, to the file the agent reads first. Foundry's own comments are left out. So a thread like this works as you would expect:

```
alice:   Also make the button blue.
bob:     And keep the old one for a week.
alice:   @foundry go
```

The agent is launched once, with all three comments in front of it.

### Labels are status and settings, never commands

Foundry owns the `state:*` labels: exactly one is on a tracked issue at a time, and only Foundry adds or removes them. Adding one by hand does nothing.

| Label | Meaning |
|---|---|
| `state:in-progress` | Agent running |
| `state:waiting-for-input` | Agent asked a question; answer with `@foundry go <answer>` |
| `state:plan-review` | Agent posted a plan; approve with `@foundry go` |
| `state:ready-for-human-review` | PR is open |
| `state:failed` | Something went wrong; see the issue comments; `@foundry go` continues |
| `state:done` | PR merged, task complete |

The labels humans set are *settings*, read when the agent is launched:

| Label | Effect |
|---|---|
| `mode:plan` | The first run produces a plan for approval instead of code. Approve with `@foundry go`, revise with `@foundry go <feedback>`. |
| `mode:auto` | Full permissions; the default when no mode label is present. |
| `mode:default` | The agent's own step-by-step permission mode. Under the Action nobody is there to answer its prompts, so this is only useful with a backend that does not prompt. |
| `agent:*` | Selects a backend via `agent_label_map`. |

### Who may command Foundry

Anyone who can comment can type `@foundry go`, and on a public repository that is everyone. Two gates stop a stranger from starting a paid run. The workflow's `if:` admits comments only from `OWNER`, `MEMBER`, and `COLLABORATOR` authors, checked before a runner starts. Inside the job, Foundry then looks up the commenter's repository permission and requires **write** or **admin**; anything less, or a lookup failure, is logged and ignored.

### Where to comment

- **Issue comments** work for all three commands.
- **PR comments** do not: a comment on the PR carries the PR number, not the issue number, and is ignored. Comment on the issue. Formal reviews with **Request changes** on the PR do work.

## A task, start to finish

```
1. Open an issue (the template gives the agent a developer-quality brief)
2. Comment @foundry go
3. Foundry claims → creates worktree → launches agent
4. Agent implements the task and submits its report
5. Foundry verifies (lint/build/test)
6. PR opened → integration; preview up; verify_preview against it
7. Human reviews the PR
8. Approve: Foundry rebases it onto integration, waits for checks, merges, marks state:done
9. Promote integration → main by PR (manual; previewed too with pull_request_bases)
```

## Sending a PR back

Two ways:

1. **Formal review** with "Request changes". Foundry feeds the review body and inline comments to the agent. Bounded by `max_input_rounds`.
2. **`@foundry go <feedback>` on the issue.** Explicit, not bounded.

Either way the agent is relaunched on its branch with the whole thread and continues from its earlier commits.

## Changing the task mid-way

**The requirements changed.** Edit the issue body, or say so in a comment, and `@foundry go`. Every launch re-reads the body and the whole thread; the agent continues from the branch.

**Start over.** `@foundry restart`. The branch is deleted and the issue is claimed fresh, with whatever labels it now has (add `mode:plan` first if you want a plan this time).

**Stop for now.** `@foundry stop`. Whatever was committed stays on the branch; `@foundry go` continues from it.

## Approving

Approving the PR on GitHub is the merge button (`review.merge_on_approval`, on by default). Foundry rebases the branch onto its base, waits for the PR's checks, merges with the rebase method, runs `integration_rebuild`, and finishes the task: `state:done`, issue closed, preview down. Red or pending checks stop before the merge with the reason on the PR. If the rebase conflicts, the agent is sent to resolve it and a second approval merges. `foundry review <pr>` does the same from a checkout.

After any merge into `integration`, Foundry checks the other open task PRs and sends the agent back to any that now conflict.

## Undoing a task

```bash
foundry reset 42            # dry run
foundry reset 42 --force    # preview down, close PR, delete remote branch, clear the state label
```

Works from any checkout; the task is rebuilt from the issue's claim comment. Comment `@foundry go` to start it again.

## Concurrent tasks

Every issue gets its own job, worktree, feature branch, and agent process. Runs for the same issue are serialised by the workflow's `concurrency` group (a `go` sent while a job is running waits for it); parallelism across issues is bounded only by your GitHub plan's concurrent-job limit.

Promotion, release tagging, and hotfixes are covered in [Integration branch](integration-strategy.md).
