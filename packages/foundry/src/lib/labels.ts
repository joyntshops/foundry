/**
 * State-label helpers.
 *
 * Every issue Foundry tracks carries exactly one `state:*` label at a time.
 * Historically each transition removed only the labels it expected to find,
 * so any path that skipped a state left a stale label behind (an issue ending
 * up with both `state:ready-for-human-review` and `state:plan-review`, for
 * example). setStateLabel enforces the invariant directly: remove every
 * configured state label except the target, then add the target if missing.
 *
 * Mode labels (`mode:*`) and agent labels (`agent:*`) are inputs, not state,
 * and are never touched here.
 */
import * as github from './github.js';
import type { FoundryConfig } from '../types.js';

export type StateLabelKey = keyof FoundryConfig['labels'];

/** All configured state label names, de-duplicated. */
export function allStateLabels(config: FoundryConfig): string[] {
  return Array.from(new Set(Object.values(config.labels)));
}

/**
 * Make `target` the issue's only state label.
 *
 * Pass `null` to clear every state label without adding one.
 *
 * @param currentLabels - If the caller already has the issue's labels (e.g.
 *   from a recently-fetched GitHubIssue), pass them to skip the extra fetch.
 */
export async function setStateLabel(
  config: FoundryConfig,
  issue: number,
  target: StateLabelKey | null,
  currentLabels?: string[],
): Promise<void> {
  const targetLabel = target ? config.labels[target] : null;
  const remove = allStateLabels(config).filter(l => l !== targetLabel);
  const add = targetLabel ? [targetLabel] : [];
  await github.transitionLabels(config.repo, issue, remove, add, currentLabels);
}
