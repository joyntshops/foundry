/**
 * foundry release [patch|minor|major] — unified monorepo version bump.
 *
 * - Bumps version in ALL configured version_sources
 * - Commits on integration
 * - Optionally tags main after merge
 */
import { loadConfig, getConfigDir } from '../config.js';
import * as git from '../lib/git.js';
import * as version from '../lib/version.js';
import * as log from '../lib/log.js';

export async function runRelease(bumpType: string): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();

  if (!['patch', 'minor', 'major'].includes(bumpType)) {
    log.error(`Invalid bump type: ${bumpType}. Use: patch, minor, or major.`);
    return;
  }

  if (config.version_sources.length === 0) {
    log.error('No version_sources configured in .joynt-foundry.yml');
    return;
  }

  // Ensure we're on integration
  const branch = git.currentBranch(repoDir);
  if (branch !== 'integration') {
    log.error(`Must be on integration branch. Currently on: ${branch}`);
    log.info('Run: git checkout integration');
    return;
  }

  git.fetchAll(repoDir);

  // Bump versions
  log.info(`Bumping ${bumpType} version across ${config.version_sources.length} file(s)...`);
  const result = version.bumpAllVersionSources(
    config.version_sources,
    bumpType as version.BumpType,
    repoDir,
  );

  log.success(`New version: ${result.version}`);
  for (const f of result.files) {
    log.info(`  Updated: ${f}`);
  }

  // Commit
  const tagName = `${config.tag_prefix}${result.version}`;
  git.commitAll(`release: ${tagName}`, repoDir);
  log.success(`Committed version bump.`);

  // Push integration
  git.push('integration', repoDir);
  log.success('Pushed integration.');

  log.info('');
  log.info('Next steps:');
  log.info(`  1. Create PR: integration → main`);
  log.info(`  2. After merge, tag main: git tag -a ${tagName} -m "Release ${tagName}"`);
  log.info(`  3. Push tag: git push origin ${tagName}`);
}
