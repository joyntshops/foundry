import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import { canCommand } from './authorize.js';
import type { FoundryConfig } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

describe('canCommand', () => {
  let mock: MockGitHubClient;
  let original: github.GitHubClient;
  beforeEach(() => { original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock); });
  afterEach(() => { github.setClient(original); });

  it('allows write and admin', async () => {
    mock.collaboratorPermission = 'write';
    expect(await canCommand(config, 'alice')).toBe(true);
    mock.collaboratorPermission = 'admin';
    expect(await canCommand(config, 'alice')).toBe(true);
    expect(mock.getCalls('getCollaboratorPermission')[0].args).toEqual(['o/r', 'alice']);
  });

  it('refuses read, triage, none, and an empty login', async () => {
    for (const p of ['read', 'triage', 'none']) {
      mock.collaboratorPermission = p;
      expect(await canCommand(config, 'mallory')).toBe(false);
    }
    expect(await canCommand(config, '')).toBe(false);
  });

  it('fails closed when the permission cannot be read', async () => {
    mock.errors.set('getCollaboratorPermission', new Error('403'));
    expect(await canCommand(config, 'alice')).toBe(false);
  });
});
