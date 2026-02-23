/**
 * Unified monorepo versioning — bump ALL version_sources together.
 *
 * Dispatches read/write by filename so non-Node projects
 * (Cargo.toml, pyproject.toml) are supported alongside package.json.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type BumpType = 'patch' | 'minor' | 'major';

// ── Pure semver helper ──────────────────────────────────────────────────

export function bumpSemver(current: string, type: BumpType): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Cannot parse semver from "${current}"`);

  let [, major, minor, patch] = match.map(Number);
  switch (type) {
    case 'major': major++; minor = 0; patch = 0; break;
    case 'minor': minor++; patch = 0; break;
    case 'patch': patch++; break;
  }
  return `${major}.${minor}.${patch}`;
}

// ── Read version from a file ────────────────────────────────────────────

export function readVersion(filePath: string): string {
  const basename = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');

  switch (basename) {
    case 'package.json': {
      const pkg = JSON.parse(content);
      if (!pkg.version) throw new Error(`No "version" field in ${filePath}`);
      return pkg.version;
    }
    case 'Cargo.toml':
    case 'pyproject.toml': {
      const m = content.match(/^version\s*=\s*"([^"]+)"/m);
      if (!m) throw new Error(`No version = "..." found in ${filePath}`);
      return m[1];
    }
    default:
      throw new Error(`Unsupported version file: ${basename}. Supported: package.json, Cargo.toml, pyproject.toml`);
  }
}

// ── Write version to a file ─────────────────────────────────────────────

export function writeVersion(filePath: string, newVersion: string): void {
  const basename = path.basename(filePath);

  switch (basename) {
    case 'package.json': {
      execFileSync('npm', ['version', newVersion, '--no-git-tag-version'], {
        cwd: path.dirname(filePath),
        encoding: 'utf-8',
        timeout: 30_000,
      });
      break;
    }
    case 'Cargo.toml':
    case 'pyproject.toml': {
      const content = fs.readFileSync(filePath, 'utf-8');
      const updated = content.replace(
        /^(version\s*=\s*")([^"]+)(")/m,
        `$1${newVersion}$3`,
      );
      fs.writeFileSync(filePath, updated, 'utf-8');
      break;
    }
    default:
      throw new Error(`Unsupported version file: ${basename}. Supported: package.json, Cargo.toml, pyproject.toml`);
  }
}

// ── Bump all configured sources ─────────────────────────────────────────

export function bumpAllVersionSources(
  versionSources: string[],
  type: BumpType,
  repoRoot: string,
): { version: string; files: string[] } {
  if (versionSources.length === 0) {
    throw new Error('No version_sources configured in .joynt-foundry.yml');
  }

  // Read current version from primary source, bump it
  const primaryPath = path.resolve(repoRoot, versionSources[0]);
  const current = readVersion(primaryPath);
  const next = bumpSemver(current, type);

  const files: string[] = [];

  // Write the new version to all sources
  for (const src of versionSources) {
    const fullPath = path.resolve(repoRoot, src);
    writeVersion(fullPath, next);
    files.push(fullPath);
  }

  return { version: next, files };
}
