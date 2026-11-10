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
  lib/preview.ts             preview up/down; url_template always wins over command output; the PR comment carries the expiry
  lib/preview-reaper.ts      schedule trigger: tear down previews past preview.ttl_hours
  lib/run-command.ts         async shell runner for verify and preview commands; never block the event loop with execSync
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
packages/broker/             the token broker behind the public Foundry App (AWS Lambda); core.ts is the
                             exchange, github.ts the App client, lambda.ts the adapter; template.yml and
                             README.md are Walter's deploy/rotation/kill-switch runbook. Walter deploys it.
docs/foundry/                user docs, written for someone installing Foundry; nothing there assumes the reader works on it
docs/foundry/maintainers/    design-notes.md (the load-bearing decisions), decisions/ (the 2026-11-03 one is why the broker
                             exists), releasing.md, public-app.md, open-source.md; README.md indexes them
```

## Working on it

```bash
npm ci
npx tsc --noEmit -p packages/foundry/tsconfig.json
npm --workspace packages/foundry test
npx tsc --noEmit -p packages/broker/tsconfig.json
npm --workspace packages/broker test
```

Those lines are exactly what CI runs; the broker has its own tests (fake JWKS, fake GitHub API, no network). Tests use vitest with `root: src`; unit tests sit next to the code as `*.test.ts`. `MockGitHubClient` in `lib/__tests__/` is the shared GitHub mock.

**Merging to `main` publishes.** `publish.yml` publishes `@joynt/foundry` to npmjs.com (trusted publishing, no token) as the next patch after the registry's latest, then pushes `vX.Y.Z` and moves `vX`, on every push to `main` that touches `packages/foundry/`. It never commits to `main`, so `package.json` lags the registry; a minor or major is a PR that sets `version`. `docs/foundry/maintainers/releasing.md` has the whole process including rollback.

**PR hygiene learned the hard way.** A PR stacked on a feature branch only retargets to `main` if that base branch is deleted at merge time; otherwise it merges into the base branch and never reaches `main`. Before telling anyone a PR is ready, confirm the head SHA on GitHub matches what you pushed; a push after the merge is silently orphaned.

## Invariants to keep

- **One `state:*` label per issue.** Always go through `setStateLabel`. Task recovery reads the label to learn the status, so a second label is a corrupted record.
- **Every job starts with nothing.** Anything a later job needs must be on GitHub before this one exits: labels, the claim comment, the status comment, the PR, the preview comment. If you add task state, add it to a comment and to `task-recovery.ts`.
- **Finish transitions in-job, or dispatch.** Events caused by the job's token do not start other runs, except `workflow_dispatch` and `repository_dispatch`. A transition that relies on "the next run will pick it up" stalls. `@foundry restart` starts the issue again inside the same job; `stale-prs.ts` dispatches the workflow with `{issue, command, message}` inputs when the work belongs to another issue's concurrency group.
- **Behavior goes in `EventHandler`.** `action.ts` is composition only.
- **Never branch on prose.** Control flow reads the agent's typed report and facts Foundry can check, nothing else. No report, an invalid report, or a report that contradicts git fails closed. If a new decision needs information only the agent has, add a field to `AGENT_REPORT_SCHEMA`; do not match text.
- **Issue text is hostile input.** Titles and bodies reach a shell. Use the `FOUNDRY_ISSUE_*` env vars; `{title}`/`{body}` are escaped for double quotes only.
- **Four commands, nothing else makes Foundry act.** `@foundry go`, `@foundry restart`, `@foundry stop` drive the agent; `@foundry preview` (and `preview off`) deploys or tears down a PR's preview, added by Walter's decision on 2026-11-10 for previews that cost money (`docs/foundry/maintainers/design-notes.md` has the reasoning). These are the only human actions (`lib/webhook.ts`). `preview` never changes a task's state and never launches the agent, and it is the only command accepted on a pull request; pull requests from forks are refused. Labels are status (`state:*`, Foundry-owned) and settings (`mode:*`, `agent:*`); plain comments are context and reach the agent through the issue file (`lib/thread.ts`). Do not add a label trigger or another comment trigger; add to what an existing command does. Commenters must have write access (`lib/authorize.ts`), with no way to widen that in config.
- **Every non-success ending pushes the branch** (`preserveWork`), so `go` on a failed task has something to continue from.
- **Branch names come from config.** `lib/branches.ts` (`integrationBranch`, `productionBranch`, `resolveBaseBranch`) is the only place that knows them. Never write `'integration'` or `'main'` in code: onboarding must not require renaming a branch that a repo's deploy tooling keys on. A missing integration branch is an error, never a fallback to production.
- **Foundry is not the agent.** Backends are configured commands. Do not special-case Claude beyond parsing its transcript format.
- **`url_template` wins.** Provider command output is only read as a URL when there is no template. `gh workflow run` prints a run URL and this bit us.

## Known gaps, in priority order

1. No verify-to-agent retry loop; a verification failure stops the task (the branch is pushed, so `@foundry go` resumes it by hand).
2. Comments on PRs resolve to the PR number, not the issue. Only `@foundry preview` is accepted there (the handler resolves the PR to its task); `go`/`restart`/`stop` and plain replies on a PR are still ignored, and workflow files older than 0.1.62 drop every PR comment until one line of their `if:` is changed.
3. Not yet run live: `@foundry preview` in any form (on demand, respawn after expiry, `off`, on a PR, the reaper). Not yet run live since the vocabulary change: `go` answering a question, `restart`, and the write-permission refusal. Run live on `cognitive-harmony-technologies/unity` (2026-10-26 to 28): `go` on a failed task, `go <feedback>` on an open PR (four rounds on one issue, PR updated in place), `stop` with no task, approval → rebase → merge → `state:done`, and the model switch by dispatching against a non-default branch. Run live under the public App on `joyntshops/foundry-demo` (2026-11-05, issue 62): broker `deny not_installed` → built-in token → PR creation refused by the org setting → `state:failed`; after the install, `go` resumed the branch, broker `allow`, PR opened as `joynt-foundry[bot]`, `pull_request` runs fired, and a `go <feedback>` round committed as the bot.

## Testing a change for real

`joyntshops/foundry-demo` is the dogfood repo (public, default branch `integration`; its README explains the setup to outsiders, so keep it honest when the wiring changes). Its workflow uses `joyntshops/foundry@v0`, the moving major tag that every release updates; point it at a branch to test unmerged work, then switch it back. `cognitive-harmony-technologies/unity` is the first production repo (integration branch `test`, Vercel previews through the Deployments API, Opus by default); its `docs/foundry.md` records the repo-specific wiring. Open an issue there, comment `@foundry go`, and watch Actions. Expected: claim comment, agent commit, PR into the configured integration branch, `state:ready-for-human-review`, preview comment with a GitHub Pages URL. Merge the PR to exercise `pull_request.closed` → `state:done` → preview down.

## Docs

The audience for `docs/foundry/` is outside users: someone installing or running Foundry, who does not work on it and should not have to read anything that assumes they do. Maintainer material (design reasons, run history, source paths, release mechanics, the public App's ownership) goes under `docs/foundry/maintainers/`, whose audience is the next session. When a run teaches something non-obvious, write the symptom into `docs/foundry/troubleshooting.md` and the design reason into `docs/foundry/maintainers/design-notes.md` so it is not rediscovered. User pages say "you", never "we" or "our runs", and never name a Joynt repository or person. Keep each fact in one place and link to it: the workflow lives in `packages/foundry/templates/foundry.yml`, the config schema in `example.joynt-foundry.yml`, the release flow in `integration-strategy.md`. No private-repo names in user docs; `CLAUDE.md` and the maintainer pages may name them.
