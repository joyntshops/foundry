# Preview Environments

Foundry is **not** a hosting provider. It orchestrates the preview lifecycle (deploy when the PR opens, redeploy on push, tear down on merge, post the URL on the PR) while a command or workflow you own does the deployment. When `.joynt-foundry.yml` has no `preview` section, none of this runs.

## Two modes

```yaml
preview:
  mode: template                                    # or provider
  url_template: https://pr-{pr_number}.preview.example.com
  comment: true                                     # post/update a PR comment with the URL (default true)
```

**Template mode** runs nothing. The URL is computed from `url_template` and posted; the hosting platform is expected to pick the branch up by itself (a branch-deploy rule, a wildcard DNS entry).

**Provider mode** runs `up_command` to deploy and `down_command` to tear down:

```yaml
preview:
  mode: provider
  url_template: https://pr-{pr_number}.preview.example.com
  up_command:   gh workflow run preview-up.yml -f pr={pr_number} -f sha={sha} -f branch={branch}
  down_command: gh workflow run preview-down.yml -f pr={pr_number}
```

When `url_template` is set it is **always** the URL, and the command's output is ignored. This is the common case, and it matters for commands like `gh workflow run`, which print an Actions run URL that is a URL but not the preview. Only when `url_template` is absent does Foundry read the URL from the command's stdout: the last line starting with `http://` or `https://`, or a JSON object with a `url` field. Under the Action, `gh` is available and `GH_TOKEN` is set, so dispatching a workflow in the same repo is the usual shape; it needs `actions: write`.

Template variables, available in `url_template`, `up_command`, and `down_command`, and also as environment variables:

| Variable | Env var | Description |
|----------|---------|-------------|
| `{branch}` | `FOUNDRY_BRANCH` | Feature branch name |
| `{branch_slug}` | `FOUNDRY_BRANCH_SLUG` | Branch name with `/` and other non-alphanumerics as `-` (hostname safe) |
| `{issue}` | `FOUNDRY_ISSUE` | Issue number; empty for a non-task PR |
| `{repo}` | `FOUNDRY_REPO` | Repository in `owner/repo` form |
| `{pr_number}` | `FOUNDRY_PR_NUMBER` | Pull request number |
| `{sha}` | `FOUNDRY_SHA` | HEAD commit of the worktree |

## Waiting for the preview

A redeploy is not up the moment the command returns. Foundry polls the URL until it answers (anything but 404 or 5xx), for up to `preview.ready_timeout_seconds` (default 300). Set `ready_match: "{sha}"` and have the page print its commit, so that a redeploy is never verified against the previous version that is still being served.

## Vercel through its GitHub integration

When Vercel's GitHub integration already deploys the repo, nothing has to run a deploy. Vercel builds every push and records each deployment in GitHub's Deployments API, so an `up_command` only has to find the record for `$FOUNDRY_SHA` with the job's own token and wait for `success`. Foundry ships that script: [`packages/foundry/templates/vercel-preview-url.sh`](../../packages/foundry/templates/vercel-preview-url.sh). Copy it into the repo and configure:

```yaml
preview:
  mode: provider
  up_command: scripts/foundry/vercel-preview-url.sh
  ready_timeout_seconds: 900           # Vercel's build time, not Foundry's
```

with `VERCEL_PREVIEW_PROJECT` set on the backend's `env` or in the workflow. Each commit has its own URL, so a relaunched task is never verified against a stale page, and no `down_command` is needed because Vercel expires previews itself. On the Vercel project:

- **Ignored Build Step** must let the feature-branch pattern build (for example `[[ "$VERCEL_GIT_COMMIT_REF" == feature/* ]]`) when the project otherwise builds production only.
- **Deployment Protection off** on that project if stakeholders without a Vercel account are to open the preview from the issue, which is most of the point.
- **A host override for host-keyed apps.** A preview answers on a generated hostname. An app that picks its tenant, site, or config from the `Host` header finds nothing there. Add an environment variable on the Preview target naming the host the preview should behave as, and route every host-keyed lookup through one function that substitutes it only when `VERCEL_ENV` is `preview`.
- **The promotion PR is the exception.** When the integration branch is the project's production branch, its commits get a *Production* deployment, where that override is off. Set `VERCEL_PRODUCTION_URL` and the script prints the production alias for those; the promotion PR's preview is then the integration site itself.

Deploying from the runner with the Vercel CLI (`up_command: vercel deploy --prebuilt --yes`) also works and needs `VERCEL_TOKEN` in the job.

## Previews for pull requests that are not tasks

Every task's PR gets a preview. Other pull requests can too, selected by base branch:

```yaml
preview:
  pull_request_bases: [main]      # also preview any PR into main
```

With this, the promotion PR from `integration` into `main` is deployed when it opens, **redeployed on every push** to its branch (so the preview tracks `integration` while the PR is open), and torn down when it closes, merged or not. The URL is posted on the PR; no issue, claim, or agent is involved. The workflow must deliver `pull_request` events and its `if:` must admit them for the listed bases; the shipped template does for the production branch. GitHub does not run `pull_request` workflows for a PR with merge conflicts, so a conflicting promotion PR gets no preview until it is clean.

## Verifying against the preview

`verify` proves the branch builds; `verify_preview` proves the deployed thing works. Commands run after the preview is up, in the branch's worktree, with `FOUNDRY_PREVIEW_URL` set:

```yaml
verify_preview:
  - 'curl -fsS "$FOUNDRY_PREVIEW_URL" | grep -q "<h1>"'
  - 'npx playwright test --base-url "$FOUNDRY_PREVIEW_URL"'
```

Fail-fast. For a task, the result gates `state:ready-for-human-review`: a failure fails the task and posts the output on the issue, exactly like a failed build. For a non-task PR, the result is posted on the PR and, when the token allows, as a check run on the head commit. This is where end-to-end tests belong once there is no shared test environment to run them in.

## GitHub Deployment records

With `github_deployments.enabled: true`, Foundry creates a GitHub Deployment each time a preview goes live, which makes previews visible under the repo's **Environments** and on the PR. Deployment calls are best-effort and never block the pipeline. One limit under the Action: the deployment id is not carried between jobs, so Foundry cannot mark the record inactive at teardown from a later job. Have the teardown workflow do that itself.

```yaml
github_deployments:
  enabled: true
  environment: preview
  production: false
```

## By hand

`foundry preview up|down|status <issue>` run the same deploy, teardown, and lookup from any checkout, for debugging and one-off use. See [CLI](cli-reference.md#foundry-preview-up-issue--down-issue--status-issue).
