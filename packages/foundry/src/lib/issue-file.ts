/**
 * The issue, written to a file the agent can read without network access.
 *
 * Telling the agent to fetch the issue from GitHub fails whenever its tools
 * are restricted: Claude Code's plan mode blocks gh, curl, and web fetches,
 * and the first real plan-mode run planned from the title alone. The brief
 * is Foundry's to deliver, so every launch writes it to
 * `<state dir>/issue.md` and exports the path as FOUNDRY_ISSUE_FILE.
 *
 * The file holds the whole human side of the issue: the body, then every
 * human comment in order (lib/thread.ts). Comments never start work, so this
 * is how they reach the agent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ThreadComment } from './thread.js';

export const ISSUE_FILE_ENV = 'FOUNDRY_ISSUE_FILE';

export interface IssueBrief {
  number: number;
  title: string;
  body: string;
  url: string;
  /** Human comments, oldest first, with Foundry's own comments removed. */
  comments?: ThreadComment[];
}

export function issueFilePath(stateDir: string): string {
  return path.join(stateDir, 'issue.md');
}

export function renderIssueFile(brief: IssueBrief): string {
  const lines = [
    `# Issue #${brief.number}: ${brief.title}`,
    '',
    brief.url,
    '',
    brief.body.trim() === '' ? '_(no description)_' : brief.body.trim(),
    '',
  ];
  const comments = brief.comments ?? [];
  if (comments.length > 0) {
    lines.push('---', '', '## Comments', '', 'Everything humans have said on this issue since it was opened, oldest first. The latest comment is the most recent instruction.', '');
    for (const c of comments) {
      lines.push(`### @${c.author} · ${c.created_at}`, '', c.body.trim(), '');
    }
  }
  return lines.join('\n');
}

/** Write the brief and return the env entry that points the agent at it. */
export function writeIssueFile(stateDir: string, brief: IssueBrief): Record<string, string> {
  const file = issueFilePath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, renderIssueFile(brief), 'utf-8');
  return { [ISSUE_FILE_ENV]: file };
}
