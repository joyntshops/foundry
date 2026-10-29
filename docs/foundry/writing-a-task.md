# Writing a task

A Foundry task is a GitHub Issue. What the agent produces depends almost entirely on what the issue says, so this page covers what the agent sees, what a good brief contains, and the levers a human has before and during a run.

## What the agent sees

At every launch Foundry gives the agent:

- **The issue**: title, URL, and body, plus **every human comment so far, in order**, written to a file the agent reads first. Foundry's own comments are left out. A relaunch after a question or a review also says what the agent asked, what the human answered, and that the branch already holds its earlier commits.
- **A standing instruction**, the kind a stakeholder gives a developer: read the whole issue; decide small things yourself and list them as assumptions; ask only when the answer changes the work, with options; change only what is needed; commit as you go; never push or open PRs; run the verify commands; report truthfully.
- **The repository**, checked out in a worktree on the task's branch, with whatever `CLAUDE.md` or equivalent the repo keeps for agents.

It does not see other issues, the PR page, or anything a human said anywhere else.

## The brief

The issue template `init` writes has four sections. They map to what reviewers check:

| Section | Answers |
|---|---|
| **What** | What should exist when this is done? One or two sentences. |
| **Acceptance criteria** | Concrete bullets the reviewer will tick off. The agent treats them as the definition of done. |
| **Constraints** | Files or areas not to touch, conventions to follow, what to avoid. |
| **Out of scope** | What a reasonable developer might include but should not. This is where most scope creep is prevented. |

Two habits pay off:

- **Name the behaviour, not the implementation**, unless the implementation is the point. "The cart badge shows a warning instead of the count when any line has a stock problem" gets a better result than a list of files to edit, and leaves the agent free to find the right place.
- **Resolve conflicts in the brief before `@foundry go`.** Given two instructions that cannot both hold, an agent picks one and may not say so. The first production tasks on Foundry lost a review round to exactly this.

## Before the run

- **`mode:plan`** on the issue makes the first run produce a plan instead of code. Approve it with `@foundry go`, revise it with `@foundry go <feedback>`. Use it for anything that touches more than one part of the system.
- **`agent:*` labels** pick a backend when the repo maps them, for example a cheaper model for a mechanical change.
- **Model.** The default is set in `.joynt-foundry.yml`. The status comment shows what each run cost, so the choice can be revisited with numbers.

## During the run

- **Answer questions with `@foundry go <answer>`** on the issue. A plain reply is kept as context but starts nothing.
- **Change the requirements** by editing the issue body or commenting, then `@foundry go`. The agent continues from its branch with the whole thread.
- **Send a PR back** with a review that requests changes, or with `@foundry go <feedback>` on the issue. Comments on the PR itself are not read.
- **Stop** with `@foundry stop`; the branch stays. **Start over** with `@foundry restart`.

## Reading the result

The PR description is the agent's own report: what it did, and the assumptions it made without asking. Read the assumptions first; they are where a brief was ambiguous. The issue's status comment records each transition with the run's cost, turns, and duration.
