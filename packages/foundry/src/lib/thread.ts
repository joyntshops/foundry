/**
 * The human thread on an issue: what the agent is given at every launch.
 *
 * Comments never start work, but everything a human writes on the issue is
 * context the agent must have. At each launch Foundry collects the issue's
 * comments, drops its own (status, claim, preview, plan, and any other bot
 * comment), strips the command text off command comments, and writes what is
 * left into the issue file after the body, in order.
 */
import * as github from './github.js';
import { commandRemainder, isBotLogin } from './webhook.js';
import type { FoundryConfig, GitHubComment } from '../types.js';

export interface ThreadComment {
  author: string;
  created_at: string;
  body: string;
}

/** Foundry's own comments all carry an HTML marker; the author check covers the rest. */
export function isFoundryComment(comment: GitHubComment): boolean {
  const login = comment.user?.login ?? '';
  return isBotLogin(login) || comment.body.includes('<!-- foundry-');
}

/** Reduce raw comments to the human thread, oldest first. */
export function threadFromComments(config: FoundryConfig, comments: GitHubComment[]): ThreadComment[] {
  const out: ThreadComment[] = [];
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const c of sorted) {
    if (isFoundryComment(c)) continue;
    const remainder = commandRemainder(c.body, config);
    const body = (remainder === null ? c.body : remainder).trim();
    if (body === '') continue;
    out.push({ author: c.user?.login ?? 'unknown', created_at: c.created_at, body });
  }
  return out;
}

/** Fetch and reduce. Never throws: a thread that cannot be read is empty. */
export async function collectThread(config: FoundryConfig, issue: number): Promise<ThreadComment[]> {
  const comments = await github.getComments(config.repo, issue);
  return threadFromComments(config, comments);
}
