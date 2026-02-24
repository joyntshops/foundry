/**
 * GitHub Deployments API — creates deployments and deployment statuses.
 *
 * Uses Octokit directly (the Deployments API has no `gh` CLI equivalent).
 * All calls are best-effort: failures are logged as warnings, never thrown.
 */
import * as log from './log.js';

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, repoName] = repo.split('/');
  return { owner, repo: repoName };
}

async function getOctokit(repo: string) {
  try {
    const { createOctokitInstance } = await import('./octokit-client.js');
    const org = repo.split('/')[0];
    return await createOctokitInstance(org);
  } catch (err: any) {
    log.warn(`Failed to create Octokit instance for deployments: ${err.message}`);
    return null;
  }
}

export interface CreateDeploymentOpts {
  repo: string;
  ref: string;
  environment: string;
  description?: string;
  transientEnvironment?: boolean;
  productionEnvironment?: boolean;
}

export async function createDeployment(opts: CreateDeploymentOpts): Promise<{ id: number } | null> {
  const ok = await getOctokit(opts.repo);
  if (!ok) return null;

  const { owner, repo } = splitRepo(opts.repo);
  try {
    const { data } = await ok.rest.repos.createDeployment({
      owner,
      repo,
      ref: opts.ref,
      environment: opts.environment,
      description: opts.description ?? 'Foundry preview deployment',
      transient_environment: opts.transientEnvironment ?? true,
      production_environment: opts.productionEnvironment ?? false,
      auto_merge: false,
      required_contexts: [],
    });
    return { id: data.id };
  } catch (err: any) {
    log.warn(`Failed to create deployment for ${opts.repo}@${opts.ref}: ${err.message}`);
    return null;
  }
}

export interface CreateDeploymentStatusOpts {
  repo: string;
  deploymentId: number;
  state: 'pending' | 'success' | 'error' | 'failure' | 'inactive' | 'in_progress';
  environmentUrl?: string;
  description?: string;
  autoInactive?: boolean;
}

export async function createDeploymentStatus(opts: CreateDeploymentStatusOpts): Promise<void> {
  const ok = await getOctokit(opts.repo);
  if (!ok) return;

  const { owner, repo } = splitRepo(opts.repo);
  try {
    await ok.rest.repos.createDeploymentStatus({
      owner,
      repo,
      deployment_id: opts.deploymentId,
      state: opts.state,
      environment_url: opts.environmentUrl,
      description: opts.description,
      auto_inactive: opts.autoInactive ?? true,
    });
  } catch (err: any) {
    log.warn(`Failed to create deployment status for deployment ${opts.deploymentId}: ${err.message}`);
  }
}
