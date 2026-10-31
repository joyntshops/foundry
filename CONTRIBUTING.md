# Contributing

Foundry is maintained in service of Joynt's own needs and is public so that others can use it and see how it is built. Contributions are welcome and are reviewed when they fit that direction; a change we would not want to maintain may be declined with thanks. Known limitations are stated in the docs rather than hidden.

## Working on it

```bash
npm ci
npx tsc --noEmit -p packages/foundry/tsconfig.json
npm --workspace packages/foundry test
```

Those three lines are what CI runs on every pull request. Tests are vitest, next to the code as `*.test.ts`; `lib/__tests__/mock-github-client.ts` is the shared GitHub mock.

Merging to `main` publishes `@joyntshops/foundry` to npmjs.com as the next patch version and tags the release. Do not edit `version` in `package.json` for a patch; a deliberate minor or major is a pull request that sets it. See [Releasing](docs/foundry/releasing.md).

## What a good change looks like

- **Behaviour lives in `lib/event-handler.ts`** and is decided from facts and the agent's typed report, never from the agent's prose. If a decision needs something only the agent knows, add a field to the report schema.
- **Every job starts empty.** Anything a later job needs must be written to GitHub (a label, a comment, the PR) and read back by `lib/task-recovery.ts`.
- **Branch names come from config.** Nothing in code may assume `integration` or `main`.
- **A new agent backend needs no code.** It is a `command` in `.joynt-foundry.yml` that ends with `foundry report`; if you think code is needed, open an issue first.
- **Docs are part of the change.** When a run teaches something non-obvious, it goes in `docs/foundry/github-action.md` (decisions) or `docs/foundry/troubleshooting.md` (symptoms). The audience includes the next agent session, not only a human operator.

`CLAUDE.md` at the repo root lists the invariants in full.

## Submitting

Open a pull request against `main` with a description of what changed and why. CI must be green. Security problems go through [SECURITY.md](SECURITY.md), not a public issue.
