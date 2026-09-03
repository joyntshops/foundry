# CLI Reference

Foundry runs as a GitHub Action. The CLI exists to set a repo up, to operate on a task from any checkout, and to manage the integration branch. None of these commands is a daemon.

## Global options

```
foundry [options] [command]

Options:
  -V, --version                    Output version number
  -v, --verbose                    Enable verbose/debug output
  --github-backend <backend>       GitHub API client: gh-cli or octokit (env: FOUNDRY_GITHUB_BACKEND)
  -h, --help                       Display help
```

Every command reads `.joynt-foundry.yml` from the current directory or a parent. Commands that touch GitHub authenticate through the App credentials from `setup-bot` if present, else `GITHUB_TOKEN`, else `gh auth token`. See [GitHub Identity](github-backends.md).

---

## Setup

### `foundry init`

Scaffold `.joynt-foundry.yml`, create the labels, and create the `integration` branch.

```bash
foundry init [--skip-labels] [--clean-labels]
```

| Option | Description |
|--------|-------------|
| `--skip-labels` | Skip creating GitHub labels |
| `--clean-labels` | Remove non-Foundry labels before creating Foundry labels |

- Detects the repo from the git remote
- Detects the project type and fills in `verify`, `integration_rebuild`, `version_sources`
- Creates the `state:*` and `mode:*` labels (list in [Onboarding](onboarding.md)), plus `agent:*` labels when `agent_label_map` has two or more entries
- Creates and pushes `integration` if missing; makes an initial commit first on an empty repo

### `foundry setup-bot`

Create a GitHub App and install it, so Foundry acts under the App's name instead of `github-actions[bot]`. Optional under the Action; the job's built-in token works without it.

```bash
foundry setup-bot
```

Opens the browser to GitHub's App manifest page, then to the install page, and saves credentials to `~/.joynt-foundry/github-app-{org}.json` and `.pem`. Copy the App ID and the `.pem` contents into the `FOUNDRY_APP_ID` and `FOUNDRY_APP_PRIVATE_KEY` secrets. Add **actions** and **deployments** write to the App's permissions afterwards and accept the update on the installation; the manifest does not include them.

---

## The Action entry point

### `foundry action`

Run the state machine for **one GitHub event** and exit. This is what `action.yml` invokes; you rarely run it by hand.

```bash
foundry action [--event-name <name>] [--event-path <file>]
```

| Option | Description |
|--------|-------------|
| `--event-name` | GitHub event name. Default: `$GITHUB_EVENT_NAME` |
| `--event-path` | Path to the event JSON payload. Default: `$GITHUB_EVENT_PATH` |

1. Loads `.joynt-foundry.yml` from the checkout
2. Rebuilds the referenced task from GitHub (claim comment, labels, PR, preview comment)
3. Maps the payload to Foundry events and dispatches them
4. If a handler launched an agent, waits for it as a subprocess, classifies the outcome, and continues; if the task was re-queued, continues into `issue_ready` in the same job
5. Writes `issue`, `status`, `branch`, `pr-url`, `log-dir`, `log-path` to `$GITHUB_OUTPUT`

Useful locally as a dry run against a saved payload: any event that maps to nothing exits 0 after recovery, which checks auth and config. See [GitHub Action](github-action.md).

---

## Operate on a task

These rebuild the task from GitHub, so they work from any checkout with no local state.

### `foundry reset <issue>`

Undo everything Foundry created for a task and put the issue back to `state:ready`. Dry-run by default.

```bash
foundry reset 42            # show what would be removed
foundry reset 42 --force    # do it
```

In order: tear down the preview, close the PR if open, delete the remote branch, set the state label to `ready`, post a note on the issue. The next `issues.labeled` event does not fire for a label the CLI added with your own token, so if you want it re-run immediately, remove and re-add `state:ready` by hand, or comment `@foundry start`.

### `foundry preview up <issue>` / `down <issue>` / `status <issue>`

Manage a task's preview environment by hand. `up` runs the configured deploy and posts or updates the PR comment; `down` runs the teardown and marks the deployment inactive; `status` prints URL, deployment id, and state. Normally the Action does all of this on PR open and merge; these exist for debugging and one-off use. See [Preview Environments](preview-environments.md).

---

## Integration branch

### `foundry review <target>`

Rebase a feature PR onto `integration`, merge it, and run `integration_rebuild`. Run from a checkout.

```bash
foundry review 42              # PR or issue number
foundry review https://...     # PR URL
```

1. Check mergeability
2. Rebase the feature branch onto `integration`
3. Push the rebased branch
4. Merge into `integration`
5. Run `integration_rebuild`
6. Label the issue `state:ready-for-human-review`

Automating this on PR approval is planned; today it is a manual step.

### `foundry release <type>`

Bump the unified version in every file listed in `version_sources`, commit on `integration`, and push.

```bash
foundry release patch | minor | major
```

Must be run on the `integration` branch. Then open a PR from `integration` to `main` and tag `main` after merge.

### `foundry sync-integration`

Merge `main` into `integration` after a hotfix landed on `main` directly. Must be run on the `integration` branch.

```bash
foundry sync-integration
```
