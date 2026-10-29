# Integration branch

Foundry merges every feature PR into one moving **integration branch**, and a human promotes that branch to **production** by PR. Both are named in `.joynt-foundry.yml` under `branches:` (defaults `integration` and `main`); a repo keeps whatever names its hosting, protection rules, and deploy workflows already key on. On this page `integration` and `main` mean those configured branches.

```
feature/42-add-login ──┐
feature/57-fix-nav  ───┤──► integration ──► main
feature/63-add-api  ───┘
```

| Branch | Purpose | How it moves |
|--------|---------|------------|
| `feature/*` | One task each, cut from `integration` | Foundry opens the PR; a human approves; Foundry rebases, waits for checks, merges |
| `integration` | Collects finished tasks; typically deploys a test environment | Promoted to `main` by a PR a human opens. With `preview.pull_request_bases: [main]` that PR gets its own preview and the same approve-to-merge flow. |
| `main` | Production | Receives promotions, and hotfixes |

A repo whose feature branches already merge into `test` or `develop` names that branch as `integration`; Foundry does not add a branch between them. The integration branch must exist on the remote: a `@foundry go` on a repo whose configured branch is missing is refused with the reason on the issue, never silently based on production.

## Promotion

Open a PR from `integration` into `main` and merge it with the merge button or by approval. There is no Foundry command for this step, by design: what goes to production is a human decision.

## Versioning and release tags

Optional. Repos that keep one version across several packages list the files under `version_sources`; the first entry is the primary.

```yaml
version_sources:
  - package.json                    # primary
  - packages/api/package.json
```

```bash
foundry release patch | minor | major   # on the integration branch
```

This reads the version from the primary source, bumps every listed file to the same next version, commits on `integration`, pushes, and prints the tag to apply to `main` after promotion (`tag_prefix`, default `v`). Repos that version some other way leave `version_sources` empty.

## Hotfixes

Fix on a branch from `main`, merge it to `main`, then bring the fix back:

```bash
foundry sync-integration    # merges main into integration; run on the integration branch
```

Without this, the next promotion PR would carry the hotfix's conflict.
