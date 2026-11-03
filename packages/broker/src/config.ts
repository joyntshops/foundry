/**
 * Broker configuration from environment variables. The private key is not
 * here: the Lambda adapter reads it from Secrets Manager.
 */
import type { BrokerConfig } from './core.js';

export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_ACTIONS_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
export const DEFAULT_AUDIENCE = 'joynt-foundry-broker';

export interface BrokerEnv {
  GITHUB_APP_ID?: string;
  OIDC_AUDIENCE?: string;
  OIDC_ISSUER?: string;
  DENY_LIST?: string;
  WORKFLOW_REF_PATTERN?: string;
  TOKEN_PERMISSIONS?: string;
  BROKER_DISABLED?: string;
  GITHUB_API_URL?: string;
  PRIVATE_KEY_SECRET_ARN?: string;
}

export function parseDenyList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function isTruthy(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? '').trim());
}

export function configFromEnv(env: BrokerEnv): BrokerConfig & { appId: string } {
  const appId = (env.GITHUB_APP_ID ?? '').trim();
  if (!appId) throw new Error('GITHUB_APP_ID is not set');

  let tokenPermissions: Record<string, string> | undefined;
  if (env.TOKEN_PERMISSIONS && env.TOKEN_PERMISSIONS.trim()) {
    const parsed: unknown = JSON.parse(env.TOKEN_PERMISSIONS);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('TOKEN_PERMISSIONS must be a JSON object');
    tokenPermissions = parsed as Record<string, string>;
  }

  return {
    appId,
    issuer: (env.OIDC_ISSUER ?? '').trim() || GITHUB_ACTIONS_ISSUER,
    audience: (env.OIDC_AUDIENCE ?? '').trim() || DEFAULT_AUDIENCE,
    denyList: parseDenyList(env.DENY_LIST),
    workflowRefPattern: env.WORKFLOW_REF_PATTERN?.trim() ? new RegExp(env.WORKFLOW_REF_PATTERN.trim()) : undefined,
    tokenPermissions,
    disabled: isTruthy(env.BROKER_DISABLED),
  };
}
