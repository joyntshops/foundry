/**
 * The exchange: a GitHub Actions OIDC token in, an installation token for
 * that one repository out. Platform-neutral; the Lambda adapter and the tests
 * inject the key lookup, the GitHub App client and the log sink.
 *
 * Every decision is written as one structured audit entry. The token never
 * appears in the log.
 */
import { jwtVerify, errors as joseErrors, type JWTVerifyGetKey, type JWTPayload } from 'jose';

export interface BrokerConfig {
  /** OIDC issuer; GitHub Actions is https://token.actions.githubusercontent.com */
  issuer: string;
  /** The `aud` the workflow must request. */
  audience: string;
  /** Owners (`owner`) and repositories (`owner/repo`) refused regardless of installation. Case-insensitive. */
  denyList: string[];
  /** When set, `job_workflow_ref` must match. */
  workflowRefPattern?: RegExp;
  /** When set, the minted token is narrowed to these permissions (GitHub refuses any not granted to the App). */
  tokenPermissions?: Record<string, string>;
  /** Kill switch: every exchange answers 503. */
  disabled: boolean;
}

export interface Installation {
  id: number;
}

export interface MintedToken {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
}

/** What the broker needs from GitHub, behind an interface so tests can fake it. */
export interface GitHubApp {
  /** Installation of the App on `owner/repo`, or null when the App is not installed there. */
  findInstallation(repository: string): Promise<Installation | null>;
  /** Mint a token for one installation, restricted to one repository. */
  mintToken(installationId: number, repositoryName: string, permissions?: Record<string, string>): Promise<MintedToken>;
  /** The App's slug (its `[bot]` login is `<slug>[bot]`), so the job can attribute commits. Cached. */
  appSlug(): Promise<string>;
}

export interface BrokerDeps {
  getKey: JWTVerifyGetKey;
  github: GitHubApp;
  log: (entry: AuditEntry) => void;
}

export type DenyReason =
  | 'disabled'
  | 'invalid_jwt'
  | 'missing_claims'
  | 'deny_list'
  | 'workflow_ref'
  | 'not_installed'
  | 'github_error';

export interface AuditEntry {
  event: 'exchange';
  decision: 'allow' | 'deny';
  reason: 'ok' | DenyReason;
  status: number;
  repository?: string;
  repository_id?: string;
  repository_owner?: string;
  installation_id?: number;
  workflow_ref?: string;
  run_id?: string;
  actor?: string;
  ref?: string;
  /** Error text for `invalid_jwt` and `github_error`; never contains a token. */
  error?: string;
}

export interface ExchangeResponse {
  status: number;
  body: Record<string, unknown>;
}

/** The OIDC claims the broker reads. GitHub documents them at docs.github.com → "OpenID Connect" → "Understanding the OIDC token". */
interface ActionsClaims {
  repository: string;
  repository_owner: string;
  repository_id?: string;
  job_workflow_ref?: string;
  run_id?: string;
  actor?: string;
  ref?: string;
}

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function readClaims(payload: JWTPayload): ActionsClaims | null {
  const repository = payload.repository;
  const owner = payload.repository_owner;
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository)) return null;
  if (typeof owner !== 'string' || owner.length === 0) return null;
  if (repository.split('/')[0].toLowerCase() !== owner.toLowerCase()) return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
  return {
    repository,
    repository_owner: owner,
    repository_id: str(payload.repository_id),
    job_workflow_ref: str(payload.job_workflow_ref),
    run_id: str(payload.run_id),
    actor: str(payload.actor),
    ref: str(payload.ref),
  };
}

export function isDenied(repository: string, denyList: string[]): boolean {
  const repo = repository.toLowerCase();
  const owner = repo.split('/')[0];
  return denyList.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.length > 0 && (e === owner || e === repo);
  });
}

function deny(
  log: BrokerDeps['log'],
  status: number,
  reason: DenyReason,
  message: string,
  claims?: Partial<ActionsClaims>,
  error?: string,
): ExchangeResponse {
  log({ event: 'exchange', decision: 'deny', reason, status, ...claimFields(claims), ...(error ? { error } : {}) });
  return { status, body: { error: reason, message } };
}

function claimFields(claims?: Partial<ActionsClaims>): Partial<AuditEntry> {
  if (!claims) return {};
  return {
    repository: claims.repository,
    repository_id: claims.repository_id,
    repository_owner: claims.repository_owner,
    workflow_ref: claims.job_workflow_ref,
    run_id: claims.run_id,
    actor: claims.actor,
    ref: claims.ref,
  };
}

/**
 * Exchange one OIDC token. Never throws for a bad request; GitHub failures
 * become a 502 with the error text in the log, not in the response body.
 */
export async function exchange(oidcToken: string, cfg: BrokerConfig, deps: BrokerDeps): Promise<ExchangeResponse> {
  if (cfg.disabled) {
    return deny(deps.log, 503, 'disabled', 'The broker is switched off. Use a self-owned App (FOUNDRY_APP_ID) until it is back.');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(oidcToken, deps.getKey, {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ['RS256'],
    }));
  } catch (err) {
    const text = err instanceof joseErrors.JOSEError ? `${err.code}: ${err.message}` : String(err);
    return deny(deps.log, 401, 'invalid_jwt', 'The OIDC token did not verify.', undefined, text);
  }

  const claims = readClaims(payload);
  if (!claims) {
    return deny(deps.log, 400, 'missing_claims', 'The OIDC token lacks a usable repository claim.', {
      repository: typeof payload.repository === 'string' ? payload.repository : undefined,
    });
  }

  if (isDenied(claims.repository, cfg.denyList)) {
    return deny(deps.log, 403, 'deny_list', 'This repository or owner is not served by this broker.', claims);
  }

  if (cfg.workflowRefPattern && !(claims.job_workflow_ref && cfg.workflowRefPattern.test(claims.job_workflow_ref))) {
    return deny(deps.log, 403, 'workflow_ref', 'The calling workflow is not one this broker serves.', claims);
  }

  let installation: Installation | null;
  try {
    installation = await deps.github.findInstallation(claims.repository);
  } catch (err) {
    return deny(deps.log, 502, 'github_error', 'GitHub did not answer the installation lookup.', claims, String(err));
  }
  if (!installation) {
    return deny(deps.log, 403, 'not_installed', 'The Foundry App is not installed on this repository. Install it from its GitHub App page.', claims);
  }

  let minted: MintedToken;
  let appSlug: string;
  try {
    minted = await deps.github.mintToken(installation.id, claims.repository.split('/')[1], cfg.tokenPermissions);
    appSlug = await deps.github.appSlug();
  } catch (err) {
    return deny(deps.log, 502, 'github_error', 'GitHub did not mint a token.', { ...claims }, String(err));
  }

  deps.log({
    event: 'exchange',
    decision: 'allow',
    reason: 'ok',
    status: 200,
    ...claimFields(claims),
    installation_id: installation.id,
  });

  return {
    status: 200,
    body: {
      token: minted.token,
      expires_at: minted.expires_at,
      repository: claims.repository,
      installation_id: installation.id,
      app_slug: appSlug,
      ...(minted.permissions ? { permissions: minted.permissions } : {}),
    },
  };
}
