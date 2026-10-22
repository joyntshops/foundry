# Integration Strategy

## Moving Integration Branch

Foundry uses a **moving integration branch** as the merge target for all feature PRs. This branch is the staging area for all in-progress work. Its name, and the production branch's, come from `branches:` in `.joynt-foundry.yml` (defaults `integration` and `main`); a repo keeps whatever names its deploy tooling already uses. On this page `integration` and `main` mean those configured branches.

```
feature/42-add-login ──┐
feature/57-fix-nav  ───┤──► integration ──► main
feature/63-add-api  ───┘
```

### Branch Hierarchy

| Branch | Purpose | Who merges |
|--------|---------|------------|
| `feature/*` | Individual task branches | Foundry (via PR) |
| `integration` | Collects all features | A human approves the PR; Foundry rebases it onto integration, waits for checks, and merges (`review.merge_on_approval`). `foundry review <pr>` does the same from a checkout. |
| `main` | Production | Manual PR from integration. With `preview.pull_request_bases: [main]` the promotion PR gets its own preview and the same approve-to-merge flow. |

Some repos keep a staging branch between the two (core-stack's `test`, for example). Foundry does not manage it; it is a manual PR from integration like `main` is.

### Setup

`foundry init` creates the integration branch if it is missing. To use an existing branch instead, name it in config and skip this:

```bash
git checkout -b integration
git push -u origin integration
```

Feature PRs always target `integration`, never `main` directly.

## Unified Monorepo Versioning

Joynt monorepos share **one unified version** across all packages. Foundry enforces this through `version_sources`.

### Configuration

```yaml
version_sources:
  - package.json                    # root — primary version source
  - packages/api/package.json
  - packages/web/package.json
  - packages/shared/package.json
```

**Rules:**
- The first entry is the **primary** version source (used to compute the release tag)
- ALL listed files are bumped to the same version simultaneously
- Foundry does NOT auto-discover package.json files — you must list them explicitly
- Order matters: primary first

### Release Tagging

Releases are recorded via annotated tags on `main`:

```
v1.0.0
v1.1.0
v1.2.0
```

The tag prefix is configurable (default: `v`).

### Release Command

```bash
# On integration branch:
foundry release patch   # v1.2.0 → v1.2.1
foundry release minor   # v1.2.0 → v1.3.0
foundry release major   # v1.2.0 → v2.0.0
```

This:
1. Reads the current version from the primary version source
2. Bumps ALL version_sources to the same next semver
3. Commits the changes on `integration`
4. Pushes `integration`
5. Prints instructions for tagging `main` after merge

### Hotfix + Sync

After a hotfix release merges to `main`:

```bash
foundry sync-integration
```

This merges `main` into `integration` so that integration stays current with production fixes.
