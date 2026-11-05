# Open source

Foundry is public under the MIT license (`LICENSE`). This page is for maintainers: it keeps the reasoning that still holds and the work still open; the February 2026 strategy memo it replaces is in git history (`docs/open-source-strategy.md`, removed October 2026).

## Why it is public

Foundry is not Joynt's product; it is how Joynt builds products. Publishing it costs nothing proprietary and is the plainest available answer to "can these people build software": typed interfaces, a real state machine, honest handling of what an agent did and did not do. That is worth more to hiring, customers, and partners than any description of the same thing.

The accepted costs: a support burden we do not promise to meet quickly, and rough edges in the open. The stance is that Foundry is maintained in service of Joynt's needs; contributions are welcome and reviewed when they fit, and known limitations are stated rather than hidden ([GitHub Action](../github-action.md#known-limitations)).

## What Joynt hosts

Nothing, with one exception decided on 2026-11-03: a token broker, so that Foundry can run as one public GitHub App that any repository installs in a click. The job sends its GitHub Actions OIDC token to the broker and gets back an installation token for that repository alone; the App's private key stays in the broker. This is the model `claude-code-action` uses. The reasoning, the security posture, and what it costs Joynt to operate are in [the decision record](decisions/2026-11-03-public-app-token-broker.md).

Two paths stay open to installers:

| | Public Foundry App (default) | Self-owned App (fallback) |
|---|---|---|
| Setup | install the App on the repository | `foundry setup-bot`, two secrets, finish the permissions by hand |
| Depends on | the joyntshops broker being up | nothing outside your organization |
| Bot identity | the Foundry bot with its icon, the same on every repository | `<YourApp>[bot]` |
| Permissions | set once by joyntshops; installations accept updates | yours to maintain |

The broker's source lives in this repository (`packages/broker/`) with the deploy and rotation commands, so anyone can run their own and point `broker-url` at it. A Marketplace listing is deferred; the App's public page is the install surface.


## Still open before a wider audience

- Screenshots an outside reader can open.
- The comparison with `claude-code-action` is a user page ([Comparison](../comparison.md)); keep it current when either side changes.
- A verify-to-agent retry loop ([known limitations](../github-action.md#known-limitations)).

Done: a public [demo repository](https://github.com/joyntshops/foundry-demo) whose issues, agent PRs, runs and previews can be read end to end, license, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, a [security model](../overview.md#security-model), CI on pull requests, public npm publishing on merge with provenance and release tags ([Releasing](releasing.md)), pinned Claude Code version, typed agent report in place of regex classification, commenter authorization, the `if: cancelled()` cleanup step, `init` writing the workflow, and a sweep of the docs for private-repo references.
