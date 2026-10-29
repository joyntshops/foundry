/**
 * Agent outcome determination.
 *
 * What happens after an agent exits is decided from three kinds of evidence,
 * none of which is the agent's prose:
 *
 *   - facts Foundry can check itself: did the run error, are there commits;
 *   - the agent's typed report (see agent-report.ts): done, needs_input,
 *     plan_ready, or blocked;
 *   - contradictions between the two, which fail closed.
 *
 * Claude Code in `-p --output-format stream-json` mode emits NDJSON events;
 * this module reads them for the result event, the session id, and the
 * structured report. Agents that emit nothing parseable are still supported
 * through the report file.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { AgentOutcome, AskUserQuestionData } from '../types.js';
import { validateReport, readReportFile, type AgentReport, type ReportResult } from './agent-report.js';

// ── Stream-JSON Event Types ──────────────────────────────────────────────

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  /** Non-null on events that belong to a subagent rather than the main conversation. */
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  structured_output?: unknown;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, any>;
    }>;
  };
  [key: string]: any;
}

// ── Parsing ──────────────────────────────────────────────────────────────

export function parseStreamJsonLog(logPath: string): StreamEvent[] {
  if (!fs.existsSync(logPath)) return [];

  const raw = fs.readFileSync(logPath, 'utf-8');
  const events: StreamEvent[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Not every line is an event (stderr is tee'd into the same file).
    }
  }

  return events;
}

export function extractSessionId(events: StreamEvent[]): string | null {
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      return event.session_id;
    }
  }
  return null;
}

/**
 * The last text the main conversation produced. Subagent events are skipped:
 * a subagent's closing sentence is not the agent's conclusion. Used for
 * display and diagnostics only, never for branching.
 */
export function extractFinalAssistantMessage(events: StreamEvent[]): string | null {
  let lastAssistantText: string | null = null;

  for (const event of events) {
    if (event.parent_tool_use_id) continue;
    if (event.type === 'assistant' && event.message?.role === 'assistant') {
      const textParts = (event.message.content ?? [])
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!);
      if (textParts.length > 0) {
        lastAssistantText = textParts.join('\n');
      }
    }
  }

  return lastAssistantText;
}

/** Cost and size of the run, as the agent CLI reports them on its result event. */
export function extractUsage(result: StreamEvent): { cost_usd?: number; turns?: number; duration_ms?: number } | undefined {
  const u: { cost_usd?: number; turns?: number; duration_ms?: number } = {};
  if (typeof result.total_cost_usd === 'number') u.cost_usd = result.total_cost_usd;
  if (typeof result.num_turns === 'number') u.turns = result.num_turns;
  if (typeof result.duration_ms === 'number') u.duration_ms = result.duration_ms;
  return Object.keys(u).length > 0 ? u : undefined;
}

/** The final `result` event of the main conversation, if the run got that far. */
export function findResultEvent(events: StreamEvent[]): StreamEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'result' && !events[i].parent_tool_use_id) return events[i];
  }
  return null;
}

/** True when the run itself failed (auth, max turns, crash), as the agent CLI reports it. */
export function resultIsError(result: StreamEvent): boolean {
  if (result.is_error === true) return true;
  return typeof result.subtype === 'string' && result.subtype !== 'success';
}

// ── Facts ────────────────────────────────────────────────────────────────

function hasCommitsBeyondBase(worktreePath: string, baseBranch: string): boolean {
  try {
    const count = execFileSync('git', ['rev-list', '--count', `${baseBranch}..HEAD`], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    return Number(count) > 0;
  } catch {
    return false;
  }
}

// ── Outcome Determination ────────────────────────────────────────────────

export interface DetermineOutcomeOptions {
  permissionMode?: string;
  /** Exit code of the agent process, when the caller waited on it. Null when killed by a signal. */
  exitCode?: number | null;
  /** Where `foundry report` writes; consulted when the transcript carries no structured output. */
  reportFile?: string;
}

function toQuestionData(report: AgentReport): AskUserQuestionData[] {
  return (report.questions ?? []).map(q => ({
    question: q.question,
    options: (q.options ?? []).map(o => ({ label: o.label, description: o.description ?? '' })),
    multiSelect: q.multi_select === true,
  }));
}

export function determineOutcome(
  logPath: string,
  worktreePath: string,
  baseBranch: string,
  options?: DetermineOutcomeOptions,
): AgentOutcome {
  const events = parseStreamJsonLog(logPath);
  const sessionId = extractSessionId(events);
  const finalMessage = extractFinalAssistantMessage(events);
  const result = findResultEvent(events);
  const usage = result ? extractUsage(result) : undefined;

  const fail = (reason: string, report: AgentReport | null = null): AgentOutcome => ({
    type: 'errored',
    session_id: sessionId,
    final_message: finalMessage ? `${reason}\n\nLast agent output:\n${finalMessage}` : reason,
    ask_user_questions: null,
    report,
    reason,
    usage,
  });

  // 1. The run itself failed.
  if (result && resultIsError(result)) {
    const detail = typeof result.result === 'string' && result.result ? `: ${result.result}` : '';
    // The CLI reports some failures (e.g. authentication) with subtype "success"
    // and is_error set; naming that subtype reads as a contradiction.
    const subtype = result.subtype && result.subtype !== 'success' ? ` (${result.subtype})` : '';
    return fail(`The agent run failed${subtype}${detail}`);
  }

  // 2. The agent's report: structured output first, then the report file.
  let parsed: ReportResult | null = null;
  if (result && result.structured_output !== undefined && result.structured_output !== null) {
    parsed = validateReport(result.structured_output);
  } else if (options?.reportFile) {
    parsed = readReportFile(options.reportFile);
  }

  if (!parsed) {
    const code = options?.exitCode;
    if (typeof code === 'number' && code !== 0) {
      return fail(`The agent process exited with code ${code} and submitted no report.`);
    }
    if (code === null) {
      return fail('The agent process was killed by a signal and submitted no report.');
    }
    return fail(
      result
        ? 'The agent finished without submitting a report. Its backend command must pass `--json-schema "$FOUNDRY_REPORT_SCHEMA"` (Claude Code) or run `foundry report` before exiting.'
        : 'The agent exited without a result and without a report.',
    );
  }
  if (!parsed.ok) {
    return fail(`The agent's report was invalid: ${parsed.error}.`);
  }

  const report = parsed.report;
  const base = { session_id: sessionId, report, usage };
  const planMode = options?.permissionMode === '--permission-mode plan';

  // 3. Branch on the typed status, checked against facts.
  switch (report.status) {
    case 'needs_input':
      return { ...base, type: 'needs-input', final_message: report.summary, ask_user_questions: toQuestionData(report) };

    case 'blocked':
      return { ...base, type: 'blocked', final_message: report.summary, ask_user_questions: null, reason: report.summary };

    case 'plan_ready':
      return { ...base, type: 'plan-completed', final_message: report.plan ?? report.summary, ask_user_questions: null };

    case 'done':
      // In plan mode nothing can have been implemented; "done" means the plan is done.
      if (planMode) {
        return { ...base, type: 'plan-completed', final_message: report.plan ?? report.summary, ask_user_questions: null };
      }
      if (!hasCommitsBeyondBase(worktreePath, baseBranch)) {
        return fail('The agent reported the task done, but the branch has no commits beyond its base.', report);
      }
      return { ...base, type: 'completed', final_message: report.summary, ask_user_questions: null };
  }
}

// ── Comment formatting ───────────────────────────────────────────────────

export function formatInputRequestComment(
  outcome: AgentOutcome,
  inputRound: number,
): string {
  const parts: string[] = [
    '<!-- foundry-input-request -->',
    `**Foundry Agent — Input Needed** (round ${inputRound})`,
    '',
  ];

  const questions = outcome.ask_user_questions ?? [];
  const summary = outcome.report?.summary;
  if (summary && !(questions.length === 1 && questions[0].question === summary)) {
    parts.push(summary, '');
  }

  if (questions.length > 0) {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selectType = q.options.length === 0 ? '' : q.multiSelect ? ' (select multiple)' : ' (select one)';
      parts.push(`**${i + 1}. ${q.question}**${selectType}`);
      for (const opt of q.options) {
        parts.push(opt.description ? `- **${opt.label}** — ${opt.description}` : `- **${opt.label}**`);
      }
      parts.push('');
    }
  } else if (outcome.final_message) {
    parts.push(outcome.final_message, '');
  }

  parts.push('Comment `@foundry go` with your answer. The agent continues from where it stopped.');
  parts.push('');
  parts.push('Or: `@foundry restart` · `@foundry stop`');

  return parts.join('\n');
}
