/**
 * A fake GitHub Actions issuer (local JWKS + signer) and a fake GitHub App
 * for the broker's tests. Nothing here touches the network.
 */
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { GitHubApp, AuditEntry, BrokerConfig, BrokerDeps, MintedToken } from './core.js';
import { GITHUB_ACTIONS_ISSUER } from './config.js';

export const AUDIENCE = 'joynt-foundry-broker';

export interface FakeIssuer {
  getKey: JWTVerifyGetKey;
  /** Sign an Actions-shaped token. Override any claim, including iss/aud/exp. */
  sign(claims?: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string; kid?: string }): Promise<string>;
  /** A token signed by a key the JWKS does not know. */
  signWithStrangerKey(claims?: Record<string, unknown>): Promise<string>;
}

export const BASE_CLAIMS: JWTPayload = {
  repository: 'acme/widgets',
  repository_owner: 'acme',
  repository_id: '12345',
  job_workflow_ref: 'acme/widgets/.github/workflows/foundry.yml@refs/heads/main',
  run_id: '98765',
  actor: 'octocat',
  ref: 'refs/heads/main',
  sub: 'repo:acme/widgets:ref:refs/heads/main',
};

export async function fakeIssuer(): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const stranger = await generateKeyPair('RS256');

  const signWith = (key: CryptoKey) => async (claims: Record<string, unknown> = {}, opts: { issuer?: string; audience?: string; expiresIn?: string; kid?: string } = {}) =>
    new SignJWT({ ...BASE_CLAIMS, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'test-key-1' })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? GITHUB_ACTIONS_ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(key);

  return {
    getKey,
    sign: signWith(privateKey),
    signWithStrangerKey: (claims) => signWith(stranger.privateKey)(claims),
  };
}

export interface FakeGitHub extends GitHubApp {
  installations: Map<string, number>;
  mints: Array<{ installationId: number; repositoryName: string; permissions?: Record<string, string> }>;
  failLookup?: Error;
  failMint?: Error;
}

export function fakeGitHub(installations: Record<string, number> = { 'acme/widgets': 777 }): FakeGitHub {
  const gh: FakeGitHub = {
    installations: new Map(Object.entries(installations).map(([k, v]) => [k.toLowerCase(), v])),
    mints: [],
    async findInstallation(repository) {
      if (gh.failLookup) throw gh.failLookup;
      const id = gh.installations.get(repository.toLowerCase());
      return id === undefined ? null : { id };
    },
    async appSlug() {
      return 'joynt-foundry';
    },
    async mintToken(installationId, repositoryName, permissions): Promise<MintedToken> {
      if (gh.failMint) throw gh.failMint;
      gh.mints.push({ installationId, repositoryName, permissions });
      return { token: `ghs_minted_${installationId}_${repositoryName}`, expires_at: '2026-11-03T12:00:00Z', permissions };
    },
  };
  return gh;
}

export function baseConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return { issuer: GITHUB_ACTIONS_ISSUER, audience: AUDIENCE, denyList: [], disabled: false, ...overrides };
}

export function deps(issuer: FakeIssuer, github: GitHubApp, log: AuditEntry[]): BrokerDeps {
  return { getKey: issuer.getKey, github, log: (e) => log.push(e) };
}
