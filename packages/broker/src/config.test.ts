import { describe, it, expect } from 'vitest';
import { configFromEnv, parseDenyList, isTruthy, DEFAULT_AUDIENCE, GITHUB_ACTIONS_ISSUER } from './config.js';

describe('configFromEnv', () => {
  it('fills defaults and requires the App id', () => {
    const cfg = configFromEnv({ GITHUB_APP_ID: ' 99 ' });
    expect(cfg).toMatchObject({ appId: '99', issuer: GITHUB_ACTIONS_ISSUER, audience: DEFAULT_AUDIENCE, denyList: [], disabled: false });
    expect(cfg.workflowRefPattern).toBeUndefined();
    expect(cfg.tokenPermissions).toBeUndefined();
    expect(() => configFromEnv({})).toThrow(/GITHUB_APP_ID/);
  });

  it('reads every knob', () => {
    const cfg = configFromEnv({
      GITHUB_APP_ID: '1',
      OIDC_AUDIENCE: 'custom',
      DENY_LIST: 'Evil, bad/repo\nother',
      WORKFLOW_REF_PATTERN: 'foundry\\.yml@',
      TOKEN_PERMISSIONS: '{"contents":"write"}',
      BROKER_DISABLED: 'true',
    });
    expect(cfg.audience).toBe('custom');
    expect(cfg.denyList).toEqual(['evil', 'bad/repo', 'other']);
    expect(cfg.workflowRefPattern?.test('x/y/.github/workflows/foundry.yml@refs/heads/main')).toBe(true);
    expect(cfg.tokenPermissions).toEqual({ contents: 'write' });
    expect(cfg.disabled).toBe(true);
  });

  it('rejects malformed permissions', () => {
    expect(() => configFromEnv({ GITHUB_APP_ID: '1', TOKEN_PERMISSIONS: '[]' })).toThrow(/JSON object/);
    expect(() => configFromEnv({ GITHUB_APP_ID: '1', TOKEN_PERMISSIONS: 'nope' })).toThrow();
  });
});

describe('helpers', () => {
  it('parseDenyList splits on commas and whitespace', () => {
    expect(parseDenyList(undefined)).toEqual([]);
    expect(parseDenyList(' a ,b  c\n')).toEqual(['a', 'b', 'c']);
  });
  it('isTruthy', () => {
    for (const v of ['1', 'true', 'YES', ' on ']) expect(isTruthy(v)).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off']) expect(isTruthy(v)).toBe(false);
  });
});
