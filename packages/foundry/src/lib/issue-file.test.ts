import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeIssueFile, renderIssueFile, ISSUE_FILE_ENV } from './issue-file.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-issue-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('issue file', () => {
  it('renders title, url, and body', () => {
    const text = renderIssueFile({ number: 7, title: 'Add login', body: '## What\nA login page.', url: 'https://github.com/o/r/issues/7' });
    expect(text).toBe('# Issue #7: Add login\n\nhttps://github.com/o/r/issues/7\n\n## What\nA login page.\n');
  });

  it('appends the human thread after the body, oldest first', () => {
    const text = renderIssueFile({ number: 7, title: 't', body: 'Body.', url: 'u', comments: [
      { author: 'alice', created_at: '2026-01-01T00:00:00Z', body: 'Also dark mode.' },
      { author: 'bob', created_at: '2026-01-02T00:00:00Z', body: 'Keep it small.' },
    ] });
    expect(text).toContain('Body.\n\n---\n\n## Comments');
    expect(text.indexOf('### @alice · 2026-01-01T00:00:00Z\n\nAlso dark mode.')).toBeLessThan(text.indexOf('### @bob'));
    expect(text).toContain('Keep it small.');
  });

  it('has no comments section when there is no thread', () => {
    expect(renderIssueFile({ number: 7, title: 't', body: 'b', url: 'u', comments: [] })).not.toContain('## Comments');
  });

  it('marks an empty body', () => {
    expect(renderIssueFile({ number: 1, title: 't', body: '  ', url: 'u' })).toContain('_(no description)_');
  });

  it('writes under the state dir and returns the env entry', () => {
    const stateDir = path.join(dir, 'state', '7');
    const env = writeIssueFile(stateDir, { number: 7, title: 't', body: 'b', url: 'u' });
    expect(env[ISSUE_FILE_ENV]).toBe(path.join(stateDir, 'issue.md'));
    expect(fs.readFileSync(env[ISSUE_FILE_ENV], 'utf-8')).toContain('# Issue #7: t');
  });

  it('overwrites a previous launch\'s file', () => {
    writeIssueFile(dir, { number: 1, title: 'old', body: '', url: 'u' });
    writeIssueFile(dir, { number: 1, title: 'new', body: '', url: 'u' });
    expect(fs.readFileSync(path.join(dir, 'issue.md'), 'utf-8')).toContain('new');
  });
});
