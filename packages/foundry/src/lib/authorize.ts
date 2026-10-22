/**
 * Who may command Foundry.
 *
 * Anyone can comment on a public repository's issues, and a comment is all it
 * takes to start a paid agent run. The workflow's `if:` filters on
 * `author_association` before a runner is even started; this is the precise
 * check inside the job: the commenter must hold write or admin permission on
 * the repository. Commands Foundry dispatches to itself are not checked here
 * (`workflow_dispatch` already requires `actions: write`).
 *
 * Fails closed: if the permission cannot be read, the command is ignored.
 */
import * as github from './github.js';
import * as log from './log.js';
import type { FoundryConfig } from '../types.js';

const ALLOWED = new Set(['admin', 'write']);

export async function canCommand(config: FoundryConfig, login: string): Promise<boolean> {
  if (!login) return false;
  try {
    const permission = await github.getCollaboratorPermission(config.repo, login);
    if (ALLOWED.has(permission)) return true;
    log.warn(`${login} has "${permission}" permission on ${config.repo}; write is required to command Foundry.`);
    return false;
  } catch (err: any) {
    log.warn(`Could not read ${login}'s permission on ${config.repo}: ${err.message}. Command ignored.`);
    return false;
  }
}
