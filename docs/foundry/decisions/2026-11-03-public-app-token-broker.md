# 2026-11-03: One public GitHub App and a hosted token broker

**Status:** accepted 2026-11-03 by Walter Moore. Implementation lands in this order: this record and the docs; the broker (`packages/broker/`); broker mode in the Action and the workflow template; the public App script and bot icon.

**Amends:** the 2026-09-02 decision that Foundry hosts nothing (the always-on runner was removed and the docs reframed around the GitHub Action; see `docs/foundry/overview.md`, "It does not host anything"). That decision stands for everything except the token broker described here.

## Context

Foundry needs a GitHub App to act as a named bot and so that the pull requests it opens trigger the repository's own workflows ([GitHub Action](../github-action.md#what-the-app-adds)). Until now each organization created its own App with `foundry setup-bot` and stored `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY` as secrets.

Two things pushed against that:

- On the demo repository a task that added a workflow file failed at push because the self-made App lacked the **Workflows** permission (joyntshops/foundry issue 30). The manifest flow cannot request every permission Foundry needs, so each installer had to add `actions`, `deployments` and `workflows` by hand and then accept the update on the installation. Several did not, and the failure only surfaced mid-task.
- The per-organization setup is more manual than the rest of onboarding: create an App, download a key, set two secrets, edit permissions, accept them. A logo and a recognisable bot name needed the same steps again per organization.

[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) solves this with one public App and a hosted endpoint that exchanges the job's GitHub Actions OIDC token for an installation token. Installing the App is one click, and the private key never leaves the endpoint.

## Options

1. **Self-owned App per organization** (status quo). No hosted component. Every installer repeats the setup; the permission set drifts between installations; commits and comments carry a different bot name per organization.
2. **One public joyntshops-owned App plus a hosted token broker.** Installation is a click on the App's public page. The Action exchanges its OIDC JWT at the broker for a short-lived installation token scoped to the calling repository. The App's permissions are set once, by joyntshops, for every installation. Joynt runs one small hosted function.
3. **Marketplace listing.** Adds discoverability and a review step by GitHub on top of option 2. It does not change the token flow, and the public App page already gives one-click install.

## Decision

Option 2, with option 1 kept as a documented fallback and option 3 deferred.

- The App is owned by the joyntshops organization and is public. Its permissions are **issues, pull_requests, contents, checks, actions, deployments, workflows: write** and **metadata: read**, and it subscribes to the events the workflow template listens for.
- The broker is an AWS Lambda function behind a function URL, in the Foundry account of the Joynt AWS organization. Walter chose AWS over a Cloudflare Worker because the App key belongs in an account Joynt already administers with SSO, CloudWatch gives the audit log retention and alarms, and reserved concurrency zero is an instant kill switch. The cost is a cold start of a few hundred milliseconds on most calls, which is invisible inside a Foundry job.
- The Action gains a `broker-url` input whose default is the joyntshops broker. When `FOUNDRY_APP_ID` is absent and `broker-url` is set, the job requests a token from the broker. When `FOUNDRY_APP_ID` is present, the self-owned App is used as today. When neither works, the job's built-in token is used as today.
- Foundry's commits are attributed to the App's bot user (`<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`) so they stop appearing as unattributed.
- Marketplace listing is deferred. The App's public page is the install surface.

## How the exchange works

1. The workflow grants `permissions: id-token: write`. The job asks GitHub for an OIDC JWT with audience `joynt-foundry-broker` (the broker's configured audience).
2. The job posts the JWT to the broker.
3. The broker verifies the signature against GitHub's JWKS (issuer `https://token.actions.githubusercontent.com`), the audience, and the expiry. It reads the `repository`, `repository_owner`, `repository_id` and `job_workflow_ref` claims.
4. The broker checks the deny-list (owners and repositories from its configuration) and, when configured, the `job_workflow_ref` allow-pattern.
5. With an App JWT signed by the private key, the broker looks up the installation for that repository. No installation means the App is not installed there, and the request is refused.
6. The broker mints an installation token restricted to that one repository and returns it with its expiry (one hour). It writes one structured log line.
7. The job masks the token and passes it to the Action as `github-token`.

Every job calls the broker once, at its start, because an installation token lives one hour and a job starts with nothing. Setup never touches the broker: installing the App is a GitHub click.

## Security posture

- **What the key can do.** The broker's private key can mint a token for every repository the App is installed on. It lives only in the broker's secret store; the Action and the installers never see it. This is the one hosted credential in Foundry and the reason the broker is small, audited, and switchable off.
- **What a request can get.** Only a token for the repository named in the OIDC claims, and only when the App is installed there. GitHub signs those claims; the broker cannot be asked for another repository's token. A caller who can run a workflow in repository X can obtain X's Foundry token, which is the same power write access to X already gives, plus the bot's name on the result. The App's permission set is the ceiling; branch rulesets still apply to the App unless it is on their bypass list.
- **Who can call it.** Anyone can reach the URL; only a valid GitHub-signed JWT gets a token. Fork pull requests do not receive `id-token: write`, so a fork cannot obtain a token for the upstream repository.
- **Key rotation.** GitHub allows more than one private key per App. Rotation is: generate a second key on the App page, store it in the broker's secret, let it take effect, delete the old key on GitHub. No downtime.
- **Kill switch.** `aws lambda put-function-concurrency --reserved-concurrent-executions 0` throttles every call at once and is reversible. The README in `packages/broker/` has the exact commands. With the broker off, every installer falls back to the self-owned App path or the built-in token.
- **Audit log.** One JSON line per request in CloudWatch Logs: decision (allow or deny), repository, installation id, workflow ref, outcome, never the token. Retention is set on the log group; a metric filter and alarm on denies is cheap.
- **Deny-list.** The broker refuses listed owners and repositories regardless of installation state, so an abusive or compromised installer can be cut off without uninstalling the App.
- **Claims that bind a request.** `repository` (whose token), `repository_id` (logged, defends against renames), `job_workflow_ref` (optional allow-pattern), `aud` (must match), `iss` (must be GitHub), `exp` (must be in the future).

## Consequences

- A new installer needs no App, no key, no `FOUNDRY_APP_*` secrets: install the public App, add `CLAUDE_CODE_OAUTH_TOKEN`, run `foundry init`, push.
- Joynt operates a hosted component for the first time: deploying it, rotating its key, watching its log, and answering for its availability. A broker outage stops new Foundry jobs for installers on the public App until the kill-switch fallback is used.
- The self-owned App path remains for organizations that will not depend on a joyntshops endpoint, and as the fallback if the broker is down. Both paths are documented; the public App is the default.
- Permission changes to the public App are made once by joyntshops; each installation still has to accept them, which GitHub prompts installers to do.
- Issue 30 is closed by the public App carrying the Workflows permission; the self-owned path's manifest also gains it.

## Hosting comparison

The full comparison that informed the platform choice (cost, cold start, key storage, deploy tooling, logging, kill switch, lock-in) was a working note; its conclusions are in the decision above. In short: both platforms are free at Foundry's volume; Cloudflare has no cold start and a two-command deploy but would have meant a new vendor account for the most sensitive credential Foundry has; AWS has the account, the audit log retention and the concurrency kill switch.
