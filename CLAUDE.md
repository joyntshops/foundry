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
  lib/agent-report.ts        the typed agent report: schema, validation, file transport, launch env
  lib/agent-output.ts        outcome = facts (run error, commits) + the report's status; no prose matching
  lib/preview.ts             preview up/down; url_template always wins over command output
  lib/preview-verify.ts      verify_preview: wait for the URL, run commands against it, gate ready-for-review
  lib/workers/subprocess.ts  runs the agent as a child of the job; the only Worker
  lib/stale-prs.ts           after a merge, find sibling PRs that now conflict and dispatch their agents (workflow_dispatch)
  lib/review.ts              approve → rebase onto base, wait for checks, merge (rebase method), integration_rebuild; shared by `foundry review`
  lib/reconcile.ts           schedule trigger: in-progress issues with no live run → failed
  commands/cancelled.ts      if: cancelled() step: a cancelled job's task → failed
  lib/worktree.ts            preserveWork (commit+push before a job ends waiting) and ensureWorktree (recreate on resume)
  lib/stores/file-store.ts   per-job cache of task state under ~/.joynt-foundry/
  backends/                  agent backends; `command` is the only type, fully generic
  lib/templates.ts           reads packages/foundry/templates/ (shipped with the package; `init` writes them into a repo)
packages/foundry/templates/  foundry.yml (the workflow, single source; docs link it) and vercel-preview-url.sh
docs/foundry/                user docs; github-action.md carries the load-bearing decisions
```

## Working on it

```bash
npm ci
npx tsc --noEmit -p packages/foundry/tsconfig.json
npm --workspace packages/foundry test
```

Those three lines are exactly what CI runs. Tests use vitest with `root: src`; unit tests sit next to the code as `*.test.ts`. `MockGitHubClient` in `lib/__tests__/` is the shared GitHub mock.

**Merging to `main` publishes.** `publish.yml` publishes `@joyntshops/foundry` to npmjs.com (trusted publishing, no token) as the next patch after the registry's latest, then pushes `vX.Y.Z` and moves `vX`, on every push to `main` that touches `packages/foundry/`. It never commits to `main`, so `package.json` lags the registry; a minor or major is a PR that sets `version`. `docs/foundry/releasing.md` has the whole process including rollback.

**PR hygiene learned the hard way.** A PR stacked on a feature branch only retargets to `main` if that base branch is deleted at merge time; otherwise it merges into the base branch and never reaches `main`. Before telling anyone a PR is ready, confirm the head SHA on GitHub matches what you pushed; a push after the merge is silently orphaned.

## Invariants to keep

- **One `state:*` label per issue.** Always go through `setStateLabel`. Task recovery reads the label to learn the status, so a second label is a corrupted record.
- **Every job starts with nothing.** Anything a later job needs must be on GitHub before this one exits: labels, the claim comment, the status comment, the PR, the preview comment. If you add task state, add it to a comment and to `task-recovery.ts`.
- **Finish transitions in-job, or dispatch.** Events caused by the job's token do not start other runs, except `workflow_dispatch` and `repository_dispatch`. A transition that relies on "the next run will pick it up" stalls. `@foundry restart` starts the issue again inside the same job; `stale-prs.ts` dispatches the workflow with `{issue, command, message}` inputs when the work belongs to another issue's concurrency group.
- **Behavior goes in `EventHandler`.** `action.ts` is composition only.
- **Never branch on prose.** Control flow reads the agent's typed report and facts Foundry can check, nothing else. No report, an invalid report, or a report that contradicts git fails closed. If a new decision needs information only the agent has, add a field to `AGENT_REPORT_SCHEMA`; do not match text.
- **Issue text is hostile input.** Titles and bodies reach a shell. Use the `FOUNDRY_ISSUE_*` env vars; `{title}`/`{body}` are escaped for double quotes only.
- **Three commands, nothing else starts work.** `@foundry go`, `@foundry restart`, `@foundry stop` are the only human actions (`lib/webhook.ts`). Labels are status (`state:*`, Foundry-owned) and settings (`mode:*`, `agent:*`); plain comments are context and reach the agent through the issue file (`lib/thread.ts`). Do not add a label trigger or a comment trigger; add to what `go` does. Commenters must have write access (`lib/authorize.ts`).
- **Every non-success ending pushes the branch** (`preserveWork`), so `go` on a failed task has something to continue from.
- **Branch names come from config.** `lib/branches.ts` (`integrationBranch`, `productionBranch`, `resolveBaseBranch`) is the only place that knows them. Never write `'integration'` or `'main'` in code: onboarding must not require renaming a branch that a repo's deploy tooling keys on. A missing integration branch is an error, never a fallback to production.
- **Foundry is not the agent.** Backends are configured commands. Do not special-case Claude beyond parsing its transcript format.
- **`url_template` wins.** Provider command output is only read as a URL when there is no template. `gh workflow run` prints a run URL and this bit us.

## Known gaps, in priority order

1. No verify-to-agent retry loop; a verification failure stops the task (the branch is pushed, so `@foundry go` resumes it by hand).
2. Comments on PRs (commands or replies) resolve to the PR number, not the issue; the workflow template excludes them and `webhook.ts` ignores them.
3. Not yet run live since the vocabulary change: `go` answering a question, `restart`, and the write-permission refusal. Run live on `cognitive-harmony-technologies/unity` (2026-10-26 to 28): `go` on a failed task, `go <feedback>` on an open PR (four rounds on one issue, PR updated in place), `stop` with no task, approval → rebase → merge → `state:done`, and the model switch by dispatching against a non-default branch.

## Testing a change for real

`joyntshops/foundry-demo` is the dogfood repo (private, default branch `integration`). Its workflow uses `joyntshops/foundry@main`; point it at a branch to test unmerged work, then switch it back. `cognitive-harmony-technologies/unity` is the first production repo (integration branch `test`, Vercel previews through the Deployments API, Opus by default); its `docs/foundry.md` records the repo-specific wiring. Open an issue there, comment `@foundry go`, and watch Actions. Expected: claim comment, agent commit, PR into the configured integration branch, `state:ready-for-human-review`, preview comment with a GitHub Pages URL. Merge the PR to exercise `pull_request.closed` → `state:done` → preview down.

## Docs

The audience for `docs/` is the next session and outside users. When a run teaches something non-obvious, write it into `docs/foundry/github-action.md` (decisions) or `docs/foundry/troubleshooting.md` (symptoms) so it is not rediscovered. Keep each fact in one place and link to it: the workflow lives in `packages/foundry/templates/foundry.yml`, the config schema in `example.joynt-foundry.yml`, the release flow in `integration-strategy.md`. No private-repo names in user docs; `CLAUDE.md` may name them.
