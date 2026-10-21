import { describe, it, expect } from 'vitest';
import { buildStatusComment } from './status-comment.js';
import type { TaskState } from '../types.js';

const task = (over: Partial<TaskState> = {}): TaskState => ({
  issue: 42, title: 'T', repo: 'o/r', branch: 'feature/42-t', worktree: '/w', tmux_session: 'foundry-42',
  agent_backend: 'claude-code', status: 'pr-open', claimed_at: '', updated_at: '', runner_id: 'r', ...over,
});

describe('status comment', () => {
  it('shows the last run cost, turns, and duration when known', () => {
    const body = buildStatusComment({ task: task({ last_run: { cost_usd: 0.4321, turns: 12, duration_ms: 65000 } }) });
    expect(body).toContain('| Last run | $0.43 · 12 turns · 1m05s |');
  });

  it('omits the row when nothing is known', () => {
    expect(buildStatusComment({ task: task() })).not.toContain('Last run');
  });

  it('formats a sub-minute run in seconds', () => {
    expect(buildStatusComment({ task: task({ last_run: { duration_ms: 17000 } }) })).toContain('| Last run | 17s |');
  });
});
