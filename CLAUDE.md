# Joynt Foundry

Orchestration layer that turns GitHub Issues into verified PRs by running a coding agent. This file is for whoever works on the repo next, agent or human. It records what is not obvious from the code.

## Shape of the repo

```
action.yml                   composite GitHub Action; the recommended way to run Foundry
packages/foundry/src/
  cli.ts                     commander entry; every command is lazy-imported
  commands/                  one file per CLI command; `action.ts` and `run.ts` are the two entry points
  lib/event-handler.ts       the state machine; every transition lives here, used by both modes
  lib/events.ts              FoundryEvent union; Poller, webhook.ts, and action.ts all produce these
  lib/poller.ts              runner mode: turns GitHub polling into events
  lib/webhook.ts             maps GitHub webhook / Actions payloads into events
  lib/task-recovery.ts       rebuilds TaskState from GitHub when local state is empty (Action mode)
  lib/labels.ts              setStateLabel: the single-state-label invariant
  lib/claim.ts               claim protocol + structured claim comment (the task's durable record)
  lib/completion.ts          exited agent → AgentCompletedEvent; shared by poller and action
  lib/agent-output.ts        parses Claude Code stream-json; classifies outcomes
  lib/preview.ts             preview up/down; url_template always wins over command output
  lib/workers/               how the agent process runs: local-tmux (runner) or subprocess (Action)
  lib/stores/                StateStore; file-store is the only implementation
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
- **Action mode is stateless.** Every job starts with an empty file store. Anything a later job needs must be on GitHub: labels, the claim comment, the PR, the preview comment. If you add task state, add it to the claim or status comment and to `task-recovery.ts`.
- **Finish transitions in-job.** Events caused by the job's token do not start other runs, except `workflow_dispatch` and `repository_dispatch`. A transition that relies on "the next run will pick it up" stalls under the Action. `continueIfRequeued` in `commands/action.ts` is the pattern.
- **Both modes share `EventHandler`.** Put behavior there, not in `run.ts` or `action.ts`. Those are composition only.
- **Foundry is not the agent.** Backends are configured commands. Do not special-case Claude beyond parsing its transcript format.

## Testing a change for real

`joyntshops/foundry-demo` is the dogfood repo (private, default branch `integration`). Its workflow uses `joyntshops/foundry@main`; point it at a branch to test unmerged work, then switch it back. Open an issue there, label it `state:ready`, and watch Actions. Expected: claim comment, agent commit, PR into `integration`, `state:ready-for-human-review`, preview comment with a GitHub Pages URL. Merge the PR to exercise `pull_request.closed` → `state:done` → preview down.

## Docs

The audience for `docs/` is the next session, not just a human operator. When a run teaches something non-obvious, write it into `docs/foundry/github-action.md` (decisions) or `docs/foundry/troubleshooting.md` (symptoms) so it is not rediscovered.
