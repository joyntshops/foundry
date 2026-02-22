/**
 * Unified monorepo versioning — bump ALL version_sources together.
 *
 * Uses `npm version` under the hood for standard semver bumping.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export type BumpType = 'patch' | 'minor' | 'major';

/**
 * Bump a package.json using `npm version`. Returns the new version string.
 * The `target` can be a bump type (patch/minor/major) or an exact version.
 */
function npmVersion(target: string, pkgDir: string): string {
  return execFileSync('npm', ['version', target, '--no-git-tag-version'], {
    cwd: pkgDir,
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim().replace(/^v/, '');
}

export function bumpAllVersionSources(
  versionSources: string[],
  type: BumpType,
  repoRoot: string,
): { version: string; files: string[] } {
  if (versionSources.length === 0) {
    throw new Error('No version_sources configured in .joynt-foundry.yml');
  }

  // Bump primary source to get the new version
  const primaryPath = path.resolve(repoRoot, versionSources[0]);
  const next = npmVersion(type, path.dirname(primaryPath));

  const files: string[] = [primaryPath];

  // Set remaining sources to the same exact version
  for (const src of versionSources.slice(1)) {
    const fullPath = path.resolve(repoRoot, src);
    npmVersion(next, path.dirname(fullPath));
    files.push(fullPath);
  }

  return { version: next, files };
}
