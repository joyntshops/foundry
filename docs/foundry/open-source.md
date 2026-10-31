# Open source

Foundry is public under the MIT license (`LICENSE`). This page keeps the reasoning that still holds and the work still open; the February 2026 strategy memo it replaces is in git history (`docs/open-source-strategy.md`, removed October 2026).

## Why it is public

Foundry is not Joynt's product; it is how Joynt builds products. Publishing it costs nothing proprietary and is the plainest available answer to "can these people build software": typed interfaces, a real state machine, honest handling of what an agent did and did not do. That is worth more to hiring, customers, and partners than any description of the same thing.

The accepted costs: a support burden we do not promise to meet quickly, and rough edges in the open. The stance is that Foundry is maintained in service of Joynt's needs; contributions are welcome and reviewed when they fit, and known limitations are stated rather than hidden ([GitHub Action](github-action.md#known-limitations)).

## Foundry and `claude-code-action`

[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) runs Claude Code inside a GitHub Actions job when someone mentions `@claude` on an issue or pull request, or on a trigger the workflow defines. It bills the user's own Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN` or an API key, runs on whatever `runs-on` the workflow names, and can read the thread, edit files, commit, push, and open or review pull requests.

Foundry runs the same way and bills the same way, and its `claude-code` preset is the same CLI. The difference is the layer:

| | `claude-code-action` | Foundry |
|---|---|---|
| Unit of work | one mention, one job, one reply | a task with a lifecycle that spans many jobs: claimed, running, waiting, PR open, done |
| What starts it | any `@claude` mention | three commands, authorized against repo permission; every other comment is context |
| Before a PR exists | whatever the agent chose to run; its push is the result | your verify commands must pass, enforced by Foundry; a failed run is posted on the issue and no PR opens |
| Previews | none | per-branch preview up on PR, redeploy on push, down on merge; `verify_preview` runs against it |
| Review | the agent can review | approve → rebase onto the integration branch → wait for checks → merge; siblings that now conflict get their agent back |
| Branch model | whatever the agent does | feature → integration → production, named per repo |
| Outcome | the agent's reply | a typed report (done, needs input, plan ready, blocked); control flow never reads prose |
| The agent | Claude Code | any CLI that can write the report; Claude Code is a preset |
| State | none between jobs | rebuilt from the issue each job: labels, claim comment, status comment, PR |

Use `claude-code-action` when a mention-and-reply is the whole job: answer a question, review a diff, make a one-off change. Use Foundry when the issue is a task that has to come out the other end as a verified, previewed, merged pull request and a stakeholder needs to steer it on the way.

## Still open before a wider audience

- Screenshots an outside reader can open.
- A verify-to-agent retry loop ([known limitations](github-action.md#known-limitations)).

Done: a public [demo repository](https://github.com/joyntshops/foundry-demo) whose issues, agent PRs, runs and previews can be read end to end, license, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, a [security model](overview.md#security-model), CI on pull requests, public npm publishing on merge with provenance and release tags ([Releasing](releasing.md)), pinned Claude Code version, typed agent report in place of regex classification, commenter authorization, the `if: cancelled()` cleanup step, `init` writing the workflow, and a sweep of the docs for private-repo references.
