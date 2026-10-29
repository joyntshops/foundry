#!/usr/bin/env bash
# Foundry preview `up_command` for a repo that Vercel's GitHub integration
# already deploys: print the URL of the Vercel deployment that built
# $FOUNDRY_SHA, waiting for it to succeed. No Vercel credential is needed.
#
# Vercel records each deployment in GitHub's Deployments API as
# "Preview – <project>" or "Production – <project>", with the deployment URL in
# `environment_url`. Reading that needs only the job's GitHub token. Each
# commit gets its own URL, so a relaunched task is never verified against a
# stale page, and no `down_command` is needed: Vercel expires previews itself.
#
# When the integration branch is the project's production branch, its commits
# get a Production deployment, whose generated hostname may not serve a
# host-keyed app correctly. For those, the project's production alias is
# printed instead (VERCEL_PRODUCTION_URL); it serves exactly this commit once
# the deployment has succeeded. This is the case for a promotion PR.
#
# Env: FOUNDRY_SHA and GH_TOKEN (set by Foundry's job), GITHUB_REPOSITORY (set by Actions),
#      VERCEL_PREVIEW_PROJECT (required: the Vercel project name),
#      VERCEL_PRODUCTION_URL (required only if the integration branch is the project's production branch),
#      VERCEL_PREVIEW_TIMEOUT (seconds, default 900).
set -u

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
PROJECT="${VERCEL_PREVIEW_PROJECT:?VERCEL_PREVIEW_PROJECT is not set}"
PRODUCTION_URL="${VERCEL_PRODUCTION_URL:-}"
SHA="${FOUNDRY_SHA:?FOUNDRY_SHA is not set}"
DEADLINE=$((SECONDS + ${VERCEL_PREVIEW_TIMEOUT:-900}))

while [ "$SECONDS" -lt "$DEADLINE" ]; do
  # Deployments for this commit, newest first; keep the one for our project.
  found=$(gh api "repos/$REPO/deployments?sha=$SHA&per_page=20" \
    --jq "[.[] | select(.environment | endswith(\"– $PROJECT\"))] | sort_by(.created_at) | last | select(. != null) | \"\(.id) \(.environment)\"" 2>/dev/null || true)
  if [ -z "$found" ]; then
    echo "Waiting for Vercel: no deployment of ${SHA:0:7} on $PROJECT recorded yet" >&2
    sleep 20; continue
  fi
  dep="${found%% *}"; environment="${found#* }"
  # Latest status wins: success carries the URL; failure/error/inactive end it.
  status=$(gh api "repos/$REPO/deployments/$dep/statuses?per_page=1" \
    --jq '.[0] | "\(.state) \(.environment_url // .target_url // "")"' 2>/dev/null || echo "unknown ")
  state="${status%% *}"; url="${status#* }"
  case "$state" in
    success)
      case "$environment" in
        Production*)
          if [ -n "$PRODUCTION_URL" ]; then
            echo "Deployment $dep of ${SHA:0:7} is the production deployment of $PROJECT; using its alias $PRODUCTION_URL" >&2
            echo "$PRODUCTION_URL"; exit 0
          fi ;;
      esac
      [ -n "$url" ] && { echo "$url"; exit 0; }
      echo "Deployment $dep succeeded but has no URL" >&2; exit 1 ;;
    failure|error|inactive)
      echo "Vercel deployment of ${SHA:0:7} on $PROJECT ended in '$state' (deployment $dep)" >&2; exit 1 ;;
    *)
      echo "Waiting for Vercel: deployment $dep of ${SHA:0:7} on $PROJECT is '${state:-pending}'" >&2; sleep 20 ;;
  esac
done
echo "Timed out waiting for the Vercel deployment of ${SHA:0:7} on $PROJECT" >&2
exit 1
