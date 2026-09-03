/**
 * Tests for the state-label invariant helper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as github from './github.js';
import { MockGitHubClient } from './__tests__/mock-github-client.js';
import { DEFAULTS } from '../config.js';
import { allStateLabels, setStateLabel } from './labels.js';
import type { FoundryConfig } from '../types.js';

const config: FoundryConfig = { ...DEFAULTS, repo: 'o/r' };

function issueWith(labels: string[]) {
  return {
    number: 1,
    title: 'T',
    body: '',
    labels: labels.map(name => ({ name })),
    html_url: '',
    state: 'open',
  };
}

describe('allStateLabels', () => {
  it('returns every configured state label exactly once', () => {
    const labels = allStateLabels(config);
    expect(labels).toHaveLength(8);
    expect(new Set(labels).size).toBe(8);
    expect(labels).toContain('state:ready');
    expect(labels).toContain('state:claim');
  });
});

describe('setStateLabel', () => {
  let mock: MockGitHubClient;
  let originalClient: github.GitHubClient;

  beforeEach(() => {
    originalClient = github.getClient();
    mock = new MockGitHubClient();
    github.setClient(mock);
  });

  afterEach(() => {
    github.setClient(originalClient);
  });

  it('removes every other state label and adds the target', async () => {
    // The exact shape of demo issue #18: two state labels at once.
    mock.issue = issueWith(['state:in-progress', 'state:plan-review', 'mode:plan']);

    await setStateLabel(config, 1, 'ready_for_review');

    const removed = mock.getCalls('removeLabel').map(c => c.args[2]).sort();
    expect(removed).toEqual(['state:in-progress', 'state:plan-review']);
    expect(mock.getCalls('addLabel')).toEqual([
      { method: 'addLabel', args: ['o/r', 1, 'state:ready-for-human-review'] },
    ]);
  });

  it('never touches mode or agent labels', async () => {
    mock.issue = issueWith(['state:ready', 'mode:plan', 'agent:claude']);

    await setStateLabel(config, 1, 'in_progress');

    const removed = mock.getCalls('removeLabel').map(c => c.args[2]);
    expect(removed).toEqual(['state:ready']);
  });

  it('is a no-op when the target is already the only state label', async () => {
    mock.issue = issueWith(['state:done', 'mode:auto']);

    await setStateLabel(config, 1, 'done');

    expect(mock.getCalls('removeLabel')).toHaveLength(0);
    expect(mock.getCalls('addLabel')).toHaveLength(0);
  });

  it('clears all state labels when target is null', async () => {
    mock.issue = issueWith(['state:waiting-for-input', 'state:in-progress']);

    await setStateLabel(config, 1, null);

    const removed = mock.getCalls('removeLabel').map(c => c.args[2]).sort();
    expect(removed).toEqual(['state:in-progress', 'state:waiting-for-input']);
    expect(mock.getCalls('addLabel')).toHaveLength(0);
  });

  it('skips the issue fetch when currentLabels are provided', async () => {
    await setStateLabel(config, 1, 'in_progress', ['state:ready']);

    expect(mock.getCalls('getIssue')).toHaveLength(0);
    expect(mock.getCalls('removeLabel').map(c => c.args[2])).toEqual(['state:ready']);
    expect(mock.getCalls('addLabel').map(c => c.args[2])).toEqual(['state:in-progress']);
  });

  it('honours custom label names from config', async () => {
    const custom: FoundryConfig = {
      ...config,
      labels: { ...config.labels, ready: 'todo', in_progress: 'doing' },
    };
    mock.issue = issueWith(['todo']);

    await setStateLabel(custom, 1, 'in_progress');

    expect(mock.getCalls('removeLabel').map(c => c.args[2])).toEqual(['todo']);
    expect(mock.getCalls('addLabel').map(c => c.args[2])).toEqual(['doing']);
  });
});
