# Joynt Foundry

Orchestration layer that turns GitHub Issues into verified PRs by running a coding agent. Foundry is a GitHub Action; there is no daemon. This file is for whoever works on the repo next, agent or human. It records what is not obvious from the code.

## Shape of the repo

```
action.yml                   composite GitHub Action; how Foundry runs
packages/foundry/src/
  cli.ts                     commander entry; every command is lazy-imported
  commands/action.ts         the Action entry point: event → recover task → EventHandler → wait on agent
  commands/reset.ts          undo a task on GitHub from any checkout (remote-only)
  commands/preview.ts        preview up/down/status by hand; rebuilds the task from GitHub
  commands/init.ts, setup-bot.ts, review.ts, release.ts, sync.ts
  lib/event-handler.ts       the state machine; every transition lives here
  lib/events.ts              FoundryEvent union; webhook.ts and action.ts produce these
  lib/webhook.ts             maps a GitHub event payload into FoundryEvents
  lib/task-recovery.ts       rebuilds TaskState from GitHub (claim comment, label, PR, preview comment)
  lib/labels.ts              setStateLabel: the single-state-label invariant
  lib/claim.ts               claim protocol + structured claim comment (the task's durable record)
  lib/completion.ts          exited agent → AgentCompletedEvent
  lib/agent-output.ts        parses Claude Code stream-json; classifies outcomes
  lib/preview.ts             preview up/down; url_template always wins over command output
  lib/workers/subprocess.ts  runs the agent as a child of the job; the only Worker
  lib/stores/file-store.ts   per-job cache of task state under ~/.joynt-foundry/
  backends/                  agent backends; `command` is the only type, fully generic
docs/foundry/                user docs; github-action.md carries the load-bearing decisions
```

## Working on it

```bash
npm ci
npx tsc --noEmit -p packages/foundry/tsconfig.json
npm --workspace packages/foundry test
```

Those three lines are exactly what CI runs. Tests use vitest with `root: src`; unit tests sit next to the code as `*.test.ts`. `MockGitHubClient` in `lib/__tests__/` is the shared GitHub mock.

**Merging to `main` publishes.** `publish.yml` bumps the patch version, tags, and publishes `@joyntshops/foundry` to GitHub Packages on every push to `main` that touches `packages/foundry/`. Never hand-edit `version` in `package.json`.

**PR hygiene learned the hard way.** A PR stacked on a feature branch only retargets to `main` if that base branch is deleted at merge time; otherwise it merges into the base branch and never reaches `main`. Before telling anyone a PR is ready, confirm the head SHA on GitHub matches what you pushed; a push after the merge is silently orphaned.

## Invariants to keep

- **One `state:*` label per issue.** Always go through `setStateLabel`. Task recovery reads the label to learn the status, so a second label is a corrupted record.
- **Every job starts with nothing.** Anything a later job needs must be on GitHub before this one exits: labels, the claim comment, the status comment, the PR, the preview comment. If you add task state, add it to a comment and to `task-recovery.ts`.
- **Finish transitions in-job.** Events caused by the job's token do not start other runs, except `workflow_dispatch` and `repository_dispatch`. A transition that relies on "the next run will pick it up" stalls. `continueIfRequeued` in `commands/action.ts` is the pattern.
- **Behavior goes in `EventHandler`.** `action.ts` is composition only.
- **Foundry is not the agent.** Backends are configured commands. Do not special-case Claude beyond parsing its transcript format.
- **`url_template` wins.** Provider command output is only read as a URL when there is no template. `gh workflow run` prints a run URL and this bit us.

## Known gaps, in priority order

1. When a job ends with the task waiting for input, the agent's partial work is not pushed and the next job has no worktree to resume into. Fix: push (WIP-commit if dirty) before exit; `ensureWorktree` on resume.
2. No verify-to-agent retry loop; a verification failure stops the task.
3. `@foundry` commands on PR comments resolve to the PR number, not the issue.
4. No `if: cancelled()` label cleanup in the template.
5. `foundry review` is manual; automating it on PR approval is the Week 3 target.

## Testing a change for real

`joyntshops/foundry-demo` is the dogfood repo (private, default branch `integration`). Its workflow uses `joyntshops/foundry@main`; point it at a branch to test unmerged work, then switch it back. Open an issue there, label it `state:ready`, and watch Actions. Expected: claim comment, agent commit, PR into `integration`, `state:ready-for-human-review`, preview comment with a GitHub Pages URL. Merge the PR to exercise `pull_request.closed` → `state:done` → preview down.

## Docs

The audience for `docs/` is the next session, not just a human operator. When a run teaches something non-obvious, write it into `docs/foundry/github-action.md` (decisions) or `docs/foundry/troubleshooting.md` (symptoms) so it is not rediscovered.
