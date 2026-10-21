/**
 * Consolidated status comment — maintains a single "Foundry Status" comment
 * per issue that updates in place as the task progresses.
 *
 * Uses the <!-- foundry-status --> marker for upsert (same pattern as preview.ts).
 * The claim comment (<!-- foundry-claim-block -->) remains separate.
 */
import * as github from './github.js';
import * as log from './log.js';
import type { TaskState, TaskStatus } from '../types.js';

const COMMENT_MARKER = '<!-- foundry-status -->';

// ── Status display mapping ───────────────────────────────────────────────

interface StatusDisplay {
  emoji: string;
  label: string;
}

const STATUS_MAP: Record<TaskStatus, StatusDisplay> = {
  'claimed':                { emoji: '📋', label: 'Claimed' },
  'agent-running':          { emoji: '🤖', label: 'Agent Running' },
  'verifying':              { emoji: '🔍', label: 'Verifying' },
  'pr-open':                { emoji: '🔀', label: 'PR Open' },
  'reviewing':              { emoji: '👀', label: 'Reviewing' },
  'waiting-for-input':      { emoji: '💬', label: 'Waiting for Input' },
  'resuming':               { emoji: '▶️', label: 'Resuming' },
  'pr-changes-requested':   { emoji: '🔄', label: 'Addressing Feedback' },
  'plan-review':            { emoji: '📝', label: 'Plan Review' },
  'done':                   { emoji: '✅', label: 'Done' },
  'failed':                 { emoji: '❌', label: 'Failed' },
  'stopped':                { emoji: '⏹️', label: 'Stopped' },
};

// ── Comment building ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m${String(r).padStart(2, '0')}s`;
}

export interface StatusCommentOpts {
  task: TaskState;
  message?: string;
  prUrl?: string;
  previewUrl?: string;
  historyEntry?: string;
}

export function buildStatusComment(opts: StatusCommentOpts): string {
  const { task, message, prUrl, previewUrl, historyEntry } = opts;
  const display = STATUS_MAP[task.status] ?? { emoji: '❓', label: task.status };
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const lines: string[] = [
    COMMENT_MARKER,
    `### ${display.emoji} Foundry Status: ${display.label}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Agent | \`${task.agent_backend}\` |`,
    `| Branch | \`${task.branch}\` |`,
  ];

  if (prUrl || task.pr_url) {
    lines.push(`| PR | ${prUrl ?? task.pr_url} |`);
  }

  if (previewUrl || task.preview_url) {
    lines.push(`| Preview | ${previewUrl ?? task.preview_url} |`);
  }

  const run = task.last_run;
  if (run && (run.cost_usd !== undefined || run.turns !== undefined || run.duration_ms !== undefined)) {
    const parts: string[] = [];
    if (run.cost_usd !== undefined) parts.push(`$${run.cost_usd.toFixed(2)}`);
    if (run.turns !== undefined) parts.push(`${run.turns} turn${run.turns === 1 ? '' : 's'}`);
    if (run.duration_ms !== undefined) parts.push(formatDuration(run.duration_ms));
    lines.push(`| Last run | ${parts.join(' · ')} |`);
  }
  lines.push(`| Updated | ${timestamp} |`);

  if (message) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(message);
  }

  // Append history entry as a compact timeline addition
  if (historyEntry) {
    lines.push('');
    lines.push(`_${timestamp} — ${historyEntry}_`);
  }

  lines.push('');
  lines.push(`<!-- /foundry-status -->`);

  return lines.join('\n');
}

// ── Upsert logic (find existing or create new) ──────────────────────────

/**
 * Find the existing status comment for an issue, or return null.
 */
async function findStatusComment(
  repo: string,
  issueOrPr: number,
): Promise<{ id: number; body: string } | null> {
  try {
    const comments = await github.getComments(repo, issueOrPr);
    const existing = comments.find(c => c.body.includes(COMMENT_MARKER));
    if (existing) {
      return { id: existing.id, body: existing.body };
    }
  } catch (err: any) {
    log.warn(`Failed to fetch comments for status upsert on #${issueOrPr}: ${err.message}`);
  }
  return null;
}

/**
 * Preserve the history timeline from an existing status comment body.
 * History entries are lines matching `_YYYY-... — ..._` at the end.
 */
function extractHistory(existingBody: string): string[] {
  const lines = existingBody.split('\n');
  const historyLines: string[] = [];
  // Walk backwards from the end, collecting timeline entries
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '<!-- /foundry-status -->') continue;
    if (line === '') continue;
    if (line.startsWith('_') && line.endsWith('_') && line.includes(' — ')) {
      historyLines.unshift(line);
    } else {
      break;
    }
  }
  return historyLines;
}

/**
 * Post or update the consolidated status comment on an issue.
 */
export async function updateStatusComment(
  repo: string,
  issueNumber: number,
  opts: StatusCommentOpts,
): Promise<void> {
  const existing = await findStatusComment(repo, issueNumber);

  // Build the new comment, preserving history from the existing one
  let historyBlock = '';
  if (existing) {
    const previousHistory = extractHistory(existing.body);
    if (opts.historyEntry) {
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      previousHistory.push(`_${timestamp} — ${opts.historyEntry}_`);
    }
    // Keep last 10 history entries to avoid bloat
    const trimmedHistory = previousHistory.slice(-10);
    if (trimmedHistory.length > 0) {
      historyBlock = '\n' + trimmedHistory.join('\n');
    }
    // Build without historyEntry since we already appended it
    opts = { ...opts, historyEntry: undefined };
  }

  let body = buildStatusComment(opts);

  // Insert accumulated history before the closing marker
  if (historyBlock) {
    body = body.replace(
      '\n<!-- /foundry-status -->',
      historyBlock + '\n\n<!-- /foundry-status -->',
    );
  }

  try {
    if (existing) {
      await github.updateComment(repo, existing.id, body);
    } else {
      await github.addComment(repo, issueNumber, body);
    }
  } catch (err: any) {
    log.warn(`Failed to upsert status comment on #${issueNumber}: ${err.message}`);
  }
}
