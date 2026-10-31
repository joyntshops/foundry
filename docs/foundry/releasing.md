# Releasing Foundry

How a change to this repository becomes a published package and a tagged Action, and what to do when a release is bad. Written for whoever cuts or repairs a release next, human or agent; nothing here is derivable from the workflow file alone.

The workflow is [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml). It runs on every push to `main` that touches `packages/foundry/` or the workflow itself, which in practice means every merged pull request that changes the package.

## One release, four artifacts

A merge to `main` produces, in this order:

1. **A version on npmjs.com**: `@joyntshops/foundry@X.Y.Z`, public, with [provenance](https://docs.npmjs.com/generating-provenance-statements) linking it to the workflow run and commit.
2. **An annotated tag `vX.Y.Z`** on the published commit. This is the immutable record of what was released; nothing moves it.
3. **The moving major tag `vX`** (today `v0`), force-updated to the same commit. Workflows that pin `uses: joyntshops/foundry@v0` receive every release until the next major.
4. Nothing on `main` itself. The job never commits; the branch ruleset requires a pull request and GitHub Actions cannot bypass it.

A failed publish leaves no tag. A published version whose tag push failed is harmless: the next run derives the version from the registry, not from the tags.

## Where the version comes from

The registry, not the repository. The job reads the latest version on npmjs.com and publishes the next patch, unless `packages/foundry/package.json` on `main` is already ahead, in which case that version is published as-is. Three cases:

| `package.json` on `main` | latest on npmjs.com | published |
|---|---|---|
| 0.1.50 | 0.1.50 | 0.1.51 |
| 0.1.50 | 0.1.57 | 0.1.58 |
| 0.2.0 | 0.1.57 | 0.2.0 |

Consequences:

- `package.json` on `main` lags the registry. `foundry --version` from a checkout prints the last version set by a pull request, not the last release. This is expected.
- **Never hand-edit `version` for a patch.** Every merge is a patch release already.
- **To cut a minor or major**, open a pull request that sets `version` in `packages/foundry/package.json` to the new `X.Y.0` (or `X.0.0`). When it merges, that version is published and tagged; later merges continue from it. A major also creates the new moving tag (`v1`) on the first release; `v0` stops moving and stays on the last 0.x release.

Two merges in quick succession publish in order: the workflow has `concurrency: group: publish` so the second waits for the first and reads the version it published.

## Registry and authentication

Releases go to **npmjs.com only**, under the `@joyntshops` scope, which is the [`joyntshops` npm organization](https://www.npmjs.com/org/joyntshops). The job authenticates with [trusted publishing](https://docs.npmjs.com/trusted-publishers): npmjs.com holds an entry saying "the workflow file `publish.yml` in `joyntshops/foundry` may publish this package", GitHub issues the job an OIDC token (`permissions: id-token: write`), and npm exchanges it for a short-lived publish credential. There is no `NPM_TOKEN` secret anywhere, nothing to rotate, and nothing to leak. Provenance is generated automatically because the repository and the package are both public.

Trusted publishing needs npm ≥ 11.5.1, so the job installs `npm@latest` before publishing.

Versions up to 0.1.51 went to GitHub Packages, which requires a token to install even a public package and so blocked `npx @joyntshops/foundry init` for anyone outside the organization. That copy is frozen; see [Installation](installation.md#if-you-installed-from-github-packages-before-november-2026) for the client-side change.

### One-time setup (done once per package; recorded so it can be redone)

Trusted publishing can only be configured on a package that already exists, so the first version must be published by hand:

1. Create the `joyntshops` organization on npmjs.com (free for public packages).
2. From a checkout of the commit to release, with `npm login` done as a member of the organization:
   ```bash
   cd packages/foundry && npm ci && npm run build
   npm publish --access public --registry https://registry.npmjs.org
   ```
   The `--registry` flag matters on a machine whose `~/.npmrc` still maps `@joyntshops` to GitHub Packages. This first version has no provenance; every later one does.
3. On npmjs.com, package settings → **Trusted Publisher** → GitHub Actions: organization `joyntshops`, repository `foundry`, workflow filename `publish.yml`, no environment. The first workflow publish must succeed within two days or the entry expires and has to be recreated.
4. Package settings → **Publishing access**: "Require two-factor authentication and disallow tokens". Trusted publishing is unaffected by this; it blocks token-based publishes, which nothing legitimate uses.

## Consuming a release

- **Workflows** pin the Action by tag: `uses: joyntshops/foundry@v0` to follow releases, or `uses: joyntshops/foundry@v0.1.52` to freeze. `@main` works but picks up every merge, released or not. The template `foundry init` writes, and the docs, use the moving major tag.
- **The CLI** is `npx @joyntshops/foundry` or `npm install -g @joyntshops/foundry`; see [Installation](installation.md).
- The Action and the CLI do not have to match. The Action builds itself from the ref the workflow names; the CLI is only used for setup and for operating on a task from a checkout.

## Checking a release

After a merge, the **Publish to npm** run on `main` should be green, and:

```bash
npm view @joyntshops/foundry version          # the new version
git ls-remote --tags origin 'v*' | tail -3    # vX.Y.Z and the moved vX
```

The version page on npmjs.com shows a "Provenance" panel naming the commit and the workflow run.

## When a release is bad

**A bad package version.** Do not unpublish: npm only allows it for 72 hours and it breaks every install that resolved the version in the meantime. Deprecate it so installs warn and `npm view` still works for the version derivation:

```bash
npm deprecate @joyntshops/foundry@0.1.57 "Broken: <what>. Use 0.1.58."
```

Then merge the fix; it publishes 0.1.58. Deprecation needs a maintainer login with 2FA; it is a hand operation by design.

**A bad Action release** (the workflow behaves wrongly for consumers pinned to `v0`). Fix forward: merge the fix, and `v0` moves to it within minutes. If consumers need relief before the fix lands, move `v0` back to the last good exact tag by hand:

```bash
git fetch --tags
git tag -fa v0 v0.1.56 -m "release: v0.1.56 (rolled back from v0.1.57)"
git push --force origin v0
```

The next publish moves it forward again, so this only buys time; a consumer who needs to stay on the good version pins `@v0.1.56`. Exact tags are never moved or deleted.

**A publish that failed** (red run, nothing on the registry). Nothing to undo. Fix the cause and re-run the job from the Actions UI, or merge the next change; either publishes the same next version.

**A tag push that failed after a successful publish.** The version exists on npmjs.com with no tag. Create the tag by hand from the run's commit (`git tag -a vX.Y.Z <sha> && git push origin vX.Y.Z`, and move `vX` if it is the latest) so the record is complete; nothing else depends on it.
