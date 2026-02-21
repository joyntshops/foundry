/**
 * Unified monorepo versioning — bump ALL version_sources together.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as semver from 'node:module';

export type BumpType = 'patch' | 'minor' | 'major';

export function readVersion(pkgPath: string): string {
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw);
  return pkg.version ?? '0.0.0';
}

export function bumpVersion(current: string, type: BumpType): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version: ${current}`);
  }
  switch (type) {
    case 'major':
      return `${parts[0] + 1}.0.0`;
    case 'minor':
      return `${parts[0]}.${parts[1] + 1}.0`;
    case 'patch':
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

export function setVersion(pkgPath: string, version: string): void {
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw);
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

export function bumpAllVersionSources(
  versionSources: string[],
  type: BumpType,
  repoRoot: string,
): { version: string; files: string[] } {
  if (versionSources.length === 0) {
    throw new Error('No version_sources configured in .joynt-foundry.yml');
  }

  // Read primary version
  const primaryPath = path.resolve(repoRoot, versionSources[0]);
  const current = readVersion(primaryPath);
  const next = bumpVersion(current, type);

  const files: string[] = [];
  for (const src of versionSources) {
    const fullPath = path.resolve(repoRoot, src);
    setVersion(fullPath, next);
    files.push(fullPath);
  }

  return { version: next, files };
}
