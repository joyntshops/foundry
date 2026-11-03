#!/usr/bin/env bash
# Build, package and deploy the broker. Run from packages/broker with an AWS
# profile for the Foundry account active (README.md). Every parameter is read
# from the environment so the command line never carries a secret.
#
#   FOUNDRY_APP_ID=123456 PRIVATE_KEY_SECRET_ARN=arn:aws:secretsmanager:... ARTIFACT_BUCKET=foundry-broker-artifacts-<account> ./scripts/deploy.sh
#
# Optional: DENY_LIST, WORKFLOW_REF_PATTERN, TOKEN_PERMISSIONS, ALARM_EMAIL, LOG_RETENTION_DAYS, STACK_NAME.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ARTIFACT_BUCKET:?set ARTIFACT_BUCKET to the S3 bucket that holds the packaged code}"
STACK_NAME="${STACK_NAME:-foundry-broker}"

overrides=()
[ -n "${FOUNDRY_APP_ID:-}" ]          && overrides+=("GitHubAppId=$FOUNDRY_APP_ID")
[ -n "${PRIVATE_KEY_SECRET_ARN:-}" ]  && overrides+=("PrivateKeySecretArn=$PRIVATE_KEY_SECRET_ARN")
[ -n "${DENY_LIST:-}" ]               && overrides+=("DenyList=$DENY_LIST")
[ -n "${WORKFLOW_REF_PATTERN:-}" ]    && overrides+=("WorkflowRefPattern=$WORKFLOW_REF_PATTERN")
[ -n "${TOKEN_PERMISSIONS:-}" ]       && overrides+=("TokenPermissions=$TOKEN_PERMISSIONS")
[ -n "${ALARM_EMAIL:-}" ]             && overrides+=("AlarmEmail=$ALARM_EMAIL")
[ -n "${LOG_RETENTION_DAYS:-}" ]      && overrides+=("LogRetentionDays=$LOG_RETENTION_DAYS")

npm run --silent build
aws cloudformation package \
  --template-file template.yml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix "$STACK_NAME" \
  --output-template-file packaged.yml >/dev/null

deploy=(aws cloudformation deploy --template-file packaged.yml --stack-name "$STACK_NAME" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset)
if [ ${#overrides[@]} -gt 0 ]; then deploy+=(--parameter-overrides "${overrides[@]}"); fi
"${deploy[@]}"

echo
echo "Broker URL:"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='BrokerUrl'].OutputValue" --output text
