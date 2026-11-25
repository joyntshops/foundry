---
name: foundry
description: How to get work done in a repository that uses Foundry (a GitHub Action that turns issues into verified pull requests). Use whenever a change to this repository's code, config or docs is needed, when writing or splitting a GitHub issue for Foundry, when drafting a "@foundry" command, when reviewing or approving a Foundry pull request or a promotion pull request, or when reporting the status of a Foundry task.
---

# Working through Foundry

This repository is onboarded to [Foundry](https://github.com/joyntshops/foundry): implementation work is done by Foundry's agent from GitHub issues, verified by Foundry, and delivered as a pull request. This skill is how a session works with it. Facts about this particular repository (its branches, verify commands, previews, labels in use, people and conventions) live in `docs/foundry.md` at the repository root. Read that file first; if it does not exist, say so and work from the defaults below.

## 1. When this applies

**Every change to the repository goes through a Foundry issue.** The session does not build it locally: no local edits to commit, no hand-made branch or pull request, no "quick fix while I am here". The session's output is:

- **Issues** written for Foundry (section 2), filed or drafted for the human to file.
- **Reviews** of Foundry pull requests (section 4).
- **Specs** and design notes that issues will be cut from.
- **Memory**: what was decided and learned, so the next session does not rediscover it.

Read-only investigation is fine and expected: clone, read code, run the tests, reproduce a bug, query the API. That investigation is what makes the issue good.

If something cannot be expressed as an issue Foundry can run, stop and ask the human rather than doing it by hand. If an issue is too big for one run, split it (section 2); never do part of it locally and leave the rest to Foundry.

## 2. Writing a Foundry-sized issue

One issue is one Foundry run is one pull request. Foundry's [Writing a task](https://github.com/joyntshops/foundry/blob/main/docs/foundry/writing-a-task.md) page is the reference for what the agent sees and the What / Acceptance criteria / Constraints / Out of scope sections of the issue template; follow it. On top of it, an issue written by a session that has investigated the code should carry what the investigation found, because the agent sees only the issue, its comments and the repository:

- **Exact files and line anchors.** `src/cart/badge.ts:42` (`renderBadge`) and the test file that covers it. Anchor on a function or symbol name as well as a line number; lines drift.
- **Wire shapes.** The exact request and response or event payloads, types, field names, status codes, config keys, environment variables. Paste them; do not describe them.
- **Known traps.** What you tried or found that will bite: the function that looks right but is dead code, the cache that hides the change, the test that passes for the wrong reason, the API that differs from its docs.
- **Acceptance criteria that name a test.** "A test in `badge.test.ts` shows the warning when any line is out of stock" beats "it works". Each criterion should be checkable from the diff and the verify run.
- **Constraints.** Files or areas not to touch, conventions, compatibility to keep.
- **Out of scope.** What a reasonable developer might add but must not, including the next issue's work.
- **Dependencies and run order.** "Depends on #12 (must be merged first)", "Run after #12, before #14." Foundry does not order issues for you: start a dependent issue only after what it depends on has merged into the integration branch, because each run is cut from it.

Sizing:

- **Too big for one run** (many areas, a migration plus its callers, more than one reviewable idea): split it into issues that each leave the repository working, link them, and state the order. A tracking issue that lists them is fine; it is never itself given `@foundry go`.
- **Use `mode:plan`** (a label, set before `go`) when the issue touches more than one part of the system, when the approach is not settled, or when a wrong approach would be expensive. The first run then posts a plan for approval instead of code.
- **Use an `agent:*` label** only when the repository maps one (`agent_label_map` in `.joynt-foundry.yml`, and `docs/foundry.md`), for example a cheaper backend for a mechanical change.
- Resolve contradictions before `go`. Given two instructions that cannot both hold, the agent picks one.

Never put credentials, tokens, customer data or anything private into an issue; issue text is read by the agent and may be public.

## 3. Driving Foundry: the control vocabulary

Exactly three commands drive the agent. They are comments **on the issue**:

| Command | Effect |
|---|---|
| `@foundry go [message]` | Start the issue, or continue it from its branch: answer a question, approve a plan, revise a plan, send a pull request back with feedback, resume a failed or stopped task. The message may follow on the same line or the next lines. |
| `@foundry restart` | Discard the branch and start the issue over from scratch. |
| `@foundry stop` | Stop the agent. The branch stays; `@foundry go` continues it. |

`@foundry preview` (and `@foundry preview off`) only deploys or tears down an open pull request's preview environment, if the repository has previews; it never starts the agent or changes the task's state.

Rules that follow from this:

- **Comments are context, never triggers.** Every human comment on the issue reaches the agent at its next launch, in order. A plain comment starts nothing. Put clarifications in comments or the issue body, then `go`.
- **Labels are status and settings, never commands.** `state:*` labels are Foundry's record of where the task is; only Foundry sets them, and adding one by hand does nothing. `mode:*` and `agent:*` are settings read at launch.
- **Plan approval is `go`.** On `state:plan-review`, `@foundry go` approves the plan as posted; `@foundry go <feedback>` revises it. There is no separate approve command.
- **Questions are answered with `go`.** On `state:waiting-for-input`, `@foundry go <answer>`.
- **A human runs the commands.** The session drafts the exact comment text, ready to paste, and says which issue it goes on and why; the human posts it. Foundry acts only on comments from people with write access. Do not post `@foundry` commands yourself unless the human explicitly asks you to post that specific comment.
- Commands on a pull request are ignored, except `@foundry preview`. Feedback on a pull request goes through a review that requests changes, or `@foundry go <feedback>` on the issue.

## 4. Reviewing a Foundry pull request

1. **Re-read the issue** and its comments, then read the pull request description (the agent's report, with the assumptions it made) and the whole diff. Check the diff against every acceptance criterion, constraint and out-of-scope item. Read the assumptions first: they mark where the issue was ambiguous.
2. **Check the evidence.** The verify check run (`Foundry Verification`) and the repository's CI must be green on the head commit. If the repository has previews, open the preview URL from the pull request and exercise the change; `@foundry preview` brings an expired preview back.
3. **Decide, and draft the human's action:**
   - **Changes needed:** a review that requests changes, with concrete feedback the agent can act on, or `@foundry go <feedback>` on the issue. If the issue itself was wrong, fix the issue body first.
   - **Good:** the human approves the pull request. Approval is the merge: Foundry rebases the branch onto its base, runs verify again on the rebased head, waits for checks, merges with the rebase method and marks the issue `state:done`. A conflict or a red re-verify sends the agent back and needs a second approval.
4. **Promotion pull requests** (the integration branch into the production branch) are merged with GitHub's merge button, not by approval. An approval would make Foundry rebase the pull request's head branch, and that branch is the integration branch itself.
5. **Required checks and hand-made pull requests.** When a branch rule requires a check that a GitHub App reports (such as `Foundry Verification`), only that App can satisfy it. A pull request Foundry did not open never gets that check, so the rule blocks it; merging it needs an admin to bypass the rule. That is why everything goes through issues. Do not ask for a bypass to land work that should have been an issue.

**Always re-verify state from GitHub before you claim it.** Labels, pull request state, head SHA, checks and merge status change under you while Foundry runs. Before telling anyone that a task is done, merged, green or waiting, read it fresh, for example:

```bash
gh issue view <n> --json state,labels,comments
gh pr view <n> --json state,mergedAt,headRefOid,reviewDecision,statusCheckRollup
```

Report what GitHub says now, not what an earlier step or a note said.

## 5. Repository-specific notes

Everything particular to this repository belongs in `docs/foundry.md`, never in this skill: branch names and what deploys from them, verify and preview details, which `agent:*` labels exist, known traps of this codebase, who approves what. When a session learns something that the next session working through Foundry here would need, propose an addition to `docs/foundry.md` (as a Foundry issue, like any other change).

This file is installed by `foundry init` and is never overwritten by it; to take a newer version, delete it and run `foundry init` again.
