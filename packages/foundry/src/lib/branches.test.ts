import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULTS } from '../config.js';
import type { FoundryConfig } from '../types.js';

vi.mock('./git.js', () => ({ remoteBranchExists: vi.fn() }));
import * as git from './git.js';
import { integrationBranch, productionBranch, resolveBaseBranch, MissingBranchError } from './branches.js';

const base: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

describe('branch names', () => {
  it('default to integration and main', () => {
    expect(integrationBranch(base)).toBe('integration');
    expect(productionBranch(base)).toBe('main');
    expect(integrationBranch({ ...base, branches: undefined as any })).toBe('integration');
  });

  it('come from config when set', () => {
    const cfg = { ...base, branches: { integration: 'test', production: 'master' } };
    expect(integrationBranch(cfg)).toBe('test');
    expect(productionBranch(cfg)).toBe('master');
  });
});

describe('resolveBaseBranch', () => {
  beforeEach(() => vi.mocked(git.remoteBranchExists).mockReset());

  it('returns origin/<integration> when the branch exists', () => {
    vi.mocked(git.remoteBranchExists).mockReturnValue(true);
    const cfg = { ...base, branches: { integration: 'test', production: 'main' } };
    expect(resolveBaseBranch(cfg, '/repo')).toBe('origin/test');
    expect(git.remoteBranchExists).toHaveBeenCalledWith('test', '/repo');
  });

  it('throws, never falls back to production, when the branch is missing', () => {
    vi.mocked(git.remoteBranchExists).mockReturnValue(false);
    expect(() => resolveBaseBranch(base, '/repo')).toThrow(MissingBranchError);
    expect(() => resolveBaseBranch(base, '/repo')).toThrow(/branches\.integration/);
  });
});
