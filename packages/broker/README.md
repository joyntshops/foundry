# Foundry token broker

The hosted half of the public Foundry GitHub App. A Foundry job sends its GitHub Actions OIDC token here and gets back a GitHub App installation token for its own repository, valid for one hour. The App's private key lives only in this broker's secret store. The decision and the security posture are in [the decision record](../../docs/foundry/decisions/2026-11-03-public-app-token-broker.md).

It is an AWS Lambda function behind a function URL, defined by [`template.yml`](template.yml) (CloudFormation) and built by esbuild into one file. Anyone may run their own copy and point the Action's `broker-url` at it.

## What it does on each request

```
POST /token          {"oidc_token": "<jwt>"}   or   Authorization: Bearer <jwt>
```

1. Verifies the JWT's RS256 signature against GitHub's JWKS (`https://token.actions.githubusercontent.com/.well-known/jwks`), the issuer, the audience (`joynt-foundry-broker` unless configured) and the expiry.
2. Reads `repository`, `repository_owner`, `repository_id`, `job_workflow_ref`, `run_id`, `actor`, `ref`. The repository must be `owner/name` and agree with `repository_owner`.
3. Refuses owners and repositories on the deny-list. Refuses a `job_workflow_ref` that does not match the allow-pattern when one is set.
4. Looks up the App's installation on that repository with an App JWT. Not installed means refused.
5. Mints an installation token restricted to that one repository (and to `TOKEN_PERMISSIONS` when set) and returns it.

| Answer | Meaning |
|---|---|
| `200 {token, expires_at, repository, installation_id, app_slug}` | allowed; `app_slug` lets the job attribute commits to `<slug>[bot]` |
| `400 missing_token` / `missing_claims` | no token sent, or no usable repository claim |
| `401 invalid_jwt` | signature, issuer, audience, expiry or algorithm failed |
| `403 deny_list` / `workflow_ref` / `not_installed` | refused by policy, or the App is not installed there |
| `502 github_error` | GitHub did not answer the lookup or the mint; the error text is in the log only |
| `503 disabled` | the kill switch |
| `500 broker_misconfigured` | the function could not load its configuration or secret |

`GET /healthz` answers `{"ok":true,"disabled":<bool>}` without touching the secret.

Every request writes one JSON line to the log, for example:

```json
{"ts":"2026-11-03T17:05:50Z","event":"exchange","decision":"allow","reason":"ok","status":200,"repository":"acme/widgets","repository_id":"12345","repository_owner":"acme","installation_id":777,"workflow_ref":"acme/widgets/.github/workflows/foundry.yml@refs/heads/main","run_id":"98765","actor":"octocat","ref":"refs/heads/main"}
```

The token is never logged. `reason` on a deny is one of `disabled`, `invalid_jwt`, `missing_claims`, `deny_list`, `workflow_ref`, `not_installed`, `github_error`.

## Configuration

Environment variables on the function; `template.yml` sets them from its parameters.

| Variable | Template parameter | Meaning |
|---|---|---|
| `GITHUB_APP_ID` | `GitHubAppId` | The App ID. |
| `PRIVATE_KEY_SECRET_ARN` | `PrivateKeySecretArn` | Secrets Manager secret holding the PEM. Re-read every 5 minutes, so rotation needs no redeploy. |
| `OIDC_AUDIENCE` | `Audience` | Default `joynt-foundry-broker`. The workflow requests its token with this audience. |
| `DENY_LIST` | `DenyList` | `owner` and `owner/repo` entries, comma separated, case-insensitive. |
| `WORKFLOW_REF_PATTERN` | `WorkflowRefPattern` | Regular expression `job_workflow_ref` must match. Empty: any workflow in an installed repository. |
| `TOKEN_PERMISSIONS` | `TokenPermissions` | JSON object narrowing the minted token, e.g. `{"contents":"write","issues":"write"}`. Empty: the App's full set. |
| `BROKER_DISABLED` | `Disabled` | `true` makes every exchange answer 503. The faster switch is below. |
| | `LogRetentionDays` | Audit log retention, default 400 days. |
| | `AlarmEmail` | When set, an SNS email on more than 20 denies in 5 minutes or any 5xx. |

## Local development

```bash
npm ci                                            # from the repository root
npx tsc --noEmit -p packages/broker/tsconfig.json
npm --workspace packages/broker test              # fake JWKS and fake GitHub; no network
npm --workspace packages/broker run build         # dist/index.mjs
```

## Deploying (Walter runs these)

All commands run from `packages/broker` in the **Foundry** account of the Joynt AWS organization (SSO profile `foundry-prod`, region `us-west-2`).

```bash
export AWS_PROFILE=foundry-prod AWS_REGION=us-west-2
aws sso login
aws sts get-caller-identity --query Account --output text   # confirm it is the Foundry account
```

### One-time setup

**The App's private key.** `foundry setup-bot --public` saves the key GitHub returns at `~/.joynt-foundry/public-app-joyntshops.pem` (mode 0600). For a key generated later on the App's settings page (`https://github.com/organizations/joyntshops/settings/apps/joynt-foundry-bot-app`, *Private keys*), GitHub downloads a `.pem`; use that path instead. Put it in Secrets Manager and delete the local file:

```bash
aws secretsmanager create-secret --name foundry-broker/github-app-private-key --description "Private key of the public Foundry GitHub App" --secret-string "file://$HOME/.joynt-foundry/public-app-joyntshops.pem"
```

```bash
rm "$HOME/.joynt-foundry/public-app-joyntshops.pem"
```

Note the `ARN` the first command prints; it is `PRIVATE_KEY_SECRET_ARN` below. The key is now readable only by the function's role and by whoever can call `GetSecretValue` in this account, and every read is in CloudTrail.

**A bucket for the packaged code**, once:

```bash
aws s3 mb "s3://foundry-broker-artifacts-$(aws sts get-caller-identity --query Account --output text)"
```

### Deploy or update

```bash
FOUNDRY_APP_ID=<app id> PRIVATE_KEY_SECRET_ARN=<arn> ARTIFACT_BUCKET=foundry-broker-artifacts-<account> ./scripts/deploy.sh
```

The script builds, uploads the bundle, creates or updates the `foundry-broker` stack and prints the broker URL. Parameters not passed keep their previous values, so a code-only update is `ARTIFACT_BUCKET=... ./scripts/deploy.sh`. The script runs, in order:

```bash
npm run build
aws cloudformation package --template-file template.yml --s3-bucket "$ARTIFACT_BUCKET" --s3-prefix foundry-broker --output-template-file packaged.yml
aws cloudformation deploy --template-file packaged.yml --stack-name foundry-broker --capabilities CAPABILITY_IAM --parameter-overrides GitHubAppId=... PrivateKeySecretArn=...
aws cloudformation describe-stacks --stack-name foundry-broker --query "Stacks[0].Outputs"
```

### Smoke test

```bash
curl -s "$(aws cloudformation describe-stacks --stack-name foundry-broker --query "Stacks[0].Outputs[?OutputKey=='BrokerUrl'].OutputValue" --output text)healthz"
```

Expected: `{"ok":true,"disabled":false}`. Then the real thing from a workflow on a repository where the App is installed, with `permissions: id-token: write`:

```yaml
- name: Token from the Foundry broker
  shell: bash
  env:
    BROKER_URL: https://tfmj7duxeutstzy3usrv6uch2q0rtwkg.lambda-url.us-west-2.on.aws/
  run: |
    oidc=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=joynt-foundry-broker" | jq -r .value)
    resp=$(curl -sS -X POST -H "Content-Type: application/json" -d "{\"oidc_token\":\"$oidc\"}" "${BROKER_URL}token")
    token=$(jq -r .token <<<"$resp"); echo "::add-mask::$token"
    jq 'del(.token)' <<<"$resp"
```

The Action's broker mode does this for you; the snippet is for checking a fresh deployment.

The broker URL is the default of the Action's `broker-url` input, so after the first deployment put it in `action.yml` and the docs. A redeploy keeps the URL; only deleting the stack changes it.

## Operating

### Kill switch

Throttle every invocation at once, no code change, reversible:

```bash
aws lambda put-function-concurrency --function-name foundry-broker --reserved-concurrent-executions 0
```

Callers then get HTTP 429 from the function URL and the Action falls back to a self-owned App or the built-in token. Restore:

```bash
aws lambda delete-function-concurrency --function-name foundry-broker
```

The slower switch, which keeps answering with a clear `503 disabled` and a log line per attempt, is the `Disabled` parameter: `aws cloudformation deploy ... --parameter-overrides Disabled=true` (through `scripts/deploy.sh` pass nothing else; or set the `BROKER_DISABLED` variable to `true` with `aws lambda update-function-configuration`, which the next stack deploy overwrites).

### Deny-list

```bash
DENY_LIST="badactor,acme/leaky-repo" ARTIFACT_BUCKET=... ./scripts/deploy.sh
```

Takes effect on the next cold start, within minutes. Entries are owners or `owner/repo`, case-insensitive.

### Key rotation

GitHub keeps every key of an App valid until it is deleted, so rotation has no downtime.

1. On the App's settings page, *Private keys* → **Generate a private key**. A new `.pem` downloads.
2. Store it as the new version of the secret, then delete the file:

```bash
aws secretsmanager put-secret-value --secret-id foundry-broker/github-app-private-key --secret-string "file://$HOME/Downloads/<new>.pem"
```

```bash
rm "$HOME/Downloads/<new>.pem"
```

3. Wait five minutes (the function re-reads the secret on that interval), confirm a job still gets a token, then delete the old key on the App page.

To force every running instance to pick the new key up immediately, change any environment variable, for example `aws lambda update-function-configuration --function-name foundry-broker --environment "Variables={...}"`, which starts new instances; the next `scripts/deploy.sh` restores the stack's values.

### Logs

Live:

```bash
aws logs tail /aws/lambda/foundry-broker --follow --format short
```

Every deny in the last day:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/foundry-broker --start-time $(( ($(date +%s) - 86400) * 1000 )) --filter-pattern '{ $.decision = "deny" }' --query 'events[].message' --output text
```

Logs Insights, one line per repository with counts (console → CloudWatch → Logs Insights, log group `/aws/lambda/foundry-broker`):

```
fields repository, decision, reason | filter event = "exchange" | stats count() by repository, decision, reason
```

Retention is `LogRetentionDays` (default 400). Alarms: pass `ALARM_EMAIL=you@example.com` to `scripts/deploy.sh` once and confirm the SNS subscription email.

### Rollback

CloudFormation keeps no code history; the repository does. Check out the previous commit of `packages/broker`, run `scripts/deploy.sh` again. For a bad configuration change, deploy with the previous parameter values.

### Teardown

```bash
aws cloudformation delete-stack --stack-name foundry-broker
```

```bash
aws secretsmanager delete-secret --secret-id foundry-broker/github-app-private-key --recovery-window-in-days 7
```

Deleting the stack changes the URL if it is ever recreated; the Action's default would then need updating.

## Running your own

Any organization that does not want to depend on the joyntshops broker can deploy this package against its own GitHub App (a self-owned App from `foundry setup-bot` works) and pass `broker-url: https://.../` to the Action. The App must be installed on the calling repositories; the exchange is otherwise identical.
