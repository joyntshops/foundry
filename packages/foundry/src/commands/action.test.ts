/**
 * runAction's gate: who may command Foundry. The preview command costs money
 * when it deploys, so it goes through the same write-access check as the
 * commands that start the agent, on an issue and on a pull request alike.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const handleEvent = vi.fn();
vi.mock('../lib/event-handler.js', () => ({
  EventHandler: class { handleEvent = handleEvent; },
}));
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>();
  return { ...real, loadConfig: () => ({ ...real.DEFAULTS, repo: 'o/r', preview: { mode: 'provider', up_command: 'deploy', trigger: 'on_demand' } }), getConfigDir: () => '/repo' };
});
vi.mock('../lib/task-recovery.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/task-recovery.js')>();
  return { ...real, recoverTask: vi.fn().mockResolvedValue(null) };
});
vi.mock('../lib/state.js', () => ({
  getTask: vi.fn().mockReturnValue(undefined),
  getAllTasks: vi.fn().mockReturnValue([]),
  upsertTask: vi.fn(),
  getLogDir: vi.fn().mockReturnValue('/tmp/logs'),
}));
vi.mock('../lib/workers/index.js', () => ({ resolveWorker: () => ({ handleFor: () => ({}) }) }));
vi.mock('../lib/log.js', () => ({ info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() }));

import * as github from '../lib/github.js';
import * as log from '../lib/log.js';
import { MockGitHubClient } from '../lib/__tests__/mock-github-client.js';
import { runAction } from './action.js';

let dir: string, mock: MockGitHubClient, original: github.GitHubClient;
const run = (payload: object) => {
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  return runAction({ eventName: 'issue_comment', eventPath });
};
const comment = (body: string, login: string, onPR = false) => ({
  action: 'created',
  repository: { full_name: 'o/r' },
  comment: { id: 1, body, user: { login } },
  issue: { number: 58, ...(onPR ? { pull_request: { url: 'x' } } : {}) },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-action-'));
  original = github.getClient(); mock = new MockGitHubClient(); github.setClient(mock);
  mock.issue = { number: 58, title: 't', body: '', labels: [], html_url: '', state: 'open' };
  mock.comments = [];
  handleEvent.mockClear();
  vi.mocked(log.warn).mockClear();
  delete process.env.GITHUB_OUTPUT;
});
afterEach(() => { github.setClient(original); fs.rmSync(dir, { recursive: true, force: true }); });

describe('runAction: the preview command needs write access', () => {
  for (const onPR of [false, true]) {
    const where = onPR ? 'a pull request' : 'an issue';

    it(`refuses a read-only commenter on ${where}: nothing reaches the handler`, async () => {
      mock.collaboratorPermission = 'read';
      await run(comment('@foundry preview', 'mallory', onPR));
      expect(mock.getCalls('getCollaboratorPermission')).toEqual([{ method: 'getCollaboratorPermission', args: ['o/r', 'mallory'] }]);
      expect(handleEvent).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('Ignoring "preview" on #58 from mallory: write access to o/r is required');
    });

    it(`obeys a commenter with write access on ${where}`, async () => {
      mock.collaboratorPermission = 'write';
      await run(comment('@foundry preview off', 'alice', onPR));
      expect(handleEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'command', command: 'preview', message: 'off', issue: 58, commentAuthor: 'alice' }));
    });
  }

  it('fails closed when the permission cannot be read', async () => {
    mock.errors.set('getCollaboratorPermission', new Error('502'));
    await run(comment('@foundry preview', 'alice'));
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it('the agent commands stay off pull requests whoever asks', async () => {
    mock.collaboratorPermission = 'admin';
    await run(comment('@foundry go', 'alice', true));
    expect(handleEvent).not.toHaveBeenCalled();
    expect(mock.getCalls('getCollaboratorPermission')).toHaveLength(0);
  });
});
