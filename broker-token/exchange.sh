#!/usr/bin/env bash
# Exchange the job's GitHub Actions OIDC token for a Foundry App installation
# token at the broker. Shared by broker-token/action.yml and action.yml.
#
# Environment in:
#   BROKER_URL        the broker (its /token route is appended); empty disables the exchange
#   BROKER_AUDIENCE   the OIDC audience the broker expects (default joynt-foundry-broker)
#   BROKER_REQUIRED   "true": a failed exchange fails the step; otherwise it warns and
#                     writes empty outputs so the workflow falls back to another token
# Outputs (GITHUB_OUTPUT): token, expires-at, repository, app-slug. Empty on failure.
set -uo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
audience="${BROKER_AUDIENCE:-joynt-foundry-broker}"
required="${BROKER_REQUIRED:-false}"

empty_outputs() {
  for k in token expires-at repository app-slug; do echo "$k=" >>"$out"; done
}

give_up() {
  # $1: one-line reason; the rest: lines of advice
  local reason="$1"; shift
  if [ "$required" = "true" ]; then
    echo "::error title=Foundry broker::$reason"
    for line in "$@"; do echo "$line"; done
    exit 1
  fi
  echo "::warning title=Foundry broker::$reason Falling back to the job's built-in token; pull requests opened with it do not trigger other workflows."
  for line in "$@"; do echo "$line"; done
  empty_outputs
  exit 0
}

if [ -z "${BROKER_URL:-}" ]; then
  give_up "No broker URL configured (broker-url is empty)."
fi

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  give_up "The job has no OIDC token." \
    "Add 'id-token: write' to the workflow's permissions block (the shipped template has it)." \
    "Docs: https://github.com/joyntshops/foundry/blob/main/docs/foundry/github-action.md#broker-mode"
fi

oidc=$(curl -sS --fail --retry 2 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${audience}" | jq -r '.value // empty') || oidc=""
if [ -z "$oidc" ]; then
  give_up "GitHub did not issue an OIDC token for audience '${audience}'."
fi
echo "::add-mask::$oidc"

token_url="${BROKER_URL%/}/token"
response=$(curl -sS --retry 2 -X POST -H 'Content-Type: application/json' -H 'User-Agent: joynt-foundry-action' \
  --data "{\"oidc_token\":\"$oidc\"}" -w $'\n%{http_code}' "$token_url") || response=$'\n000'
status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$status" != "200" ]; then
  error=$(jq -r '.error // "unknown"' <<<"$body" 2>/dev/null || echo unknown)
  message=$(jq -r '.message // ""' <<<"$body" 2>/dev/null || true)
  case "$error" in
    not_installed)
      give_up "The Foundry App is not installed on this repository (broker answered 403 not_installed)." \
        "Install it from the App's page, or set FOUNDRY_APP_ID and FOUNDRY_APP_PRIVATE_KEY for a self-owned App." \
        "$message" ;;
    disabled)
      give_up "The broker is switched off (503 disabled)." "$message" ;;
    deny_list|workflow_ref)
      give_up "The broker refused this repository (403 $error)." "$message" ;;
    *)
      give_up "The broker answered HTTP ${status} (${error})." "$message" "URL: $token_url" ;;
  esac
fi

token=$(jq -r '.token // empty' <<<"$body")
if [ -z "$token" ]; then
  give_up "The broker answered 200 without a token."
fi
echo "::add-mask::$token"

{
  echo "token=$token"
  echo "expires-at=$(jq -r '.expires_at // empty' <<<"$body")"
  echo "repository=$(jq -r '.repository // empty' <<<"$body")"
  echo "app-slug=$(jq -r '.app_slug // empty' <<<"$body")"
} >>"$out"
echo "Foundry broker: token for $(jq -r '.repository // "?"' <<<"$body") as $(jq -r '.app_slug // "?"' <<<"$body")[bot], expires $(jq -r '.expires_at // "?"' <<<"$body")."
