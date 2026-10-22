/**
 * The two long-lived branches Foundry works against, by configured name.
 *
 * Nothing in Foundry may assume `integration` or `main`: a repo being
 * onboarded already has branch names that its deploy pipeline, protection
 * rules, and hosting provider key on, and renaming them to suit Foundry is
 * not a reasonable precondition. `branches:` in .joynt-foundry.yml names
 * them; the defaults are `integration` and `main`.
 */
import * as git from './git.js';
import type { FoundryConfig } from '../types.js';

export const DEFAULT_BRANCHES = { integration: 'integration', production: 'main' } as const;

/** The moving branch feature PRs merge into. */
export function integrationBranch(config: FoundryConfig): string {
  return config.branches?.integration || DEFAULT_BRANCHES.integration;
}

/** The branch the integration branch is promoted to. */
export function productionBranch(config: FoundryConfig): string {
  return config.branches?.production || DEFAULT_BRANCHES.production;
}

export class MissingBranchError extends Error {
  constructor(public readonly branch: string) {
    super(
      `The integration branch "${branch}" does not exist on origin. ` +
      `Create it (\`git push origin HEAD:${branch}\`), or set \`branches.integration\` in .joynt-foundry.yml to the branch feature work should be based on and merged into.`,
    );
    this.name = 'MissingBranchError';
  }
}

/**
 * The ref agent branches are cut from and measured against:
 * `origin/<integration>`. Throws when that branch does not exist on the
 * remote. There is deliberately no fallback to the production branch: work
 * silently based on `main` when `integration` was misspelled is worse than a
 * clear error.
 */
export function resolveBaseBranch(config: FoundryConfig, repoDir?: string): string {
  const branch = integrationBranch(config);
  if (!git.remoteBranchExists(branch, repoDir)) throw new MissingBranchError(branch);
  return `origin/${branch}`;
}
