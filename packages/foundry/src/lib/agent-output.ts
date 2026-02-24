/**
 * Stream-json log parser and agent outcome determination.
 *
 * Claude Code in `-p --output-format stream-json` mode emits NDJSON events.
 * This module reads those logs and determines whether the agent completed work,
 * needs human input, or errored out.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { AgentOutcome, AgentOutcomeType, AskUserQuestionData, AskUserQuestionOption } from '../types.js';

// ── Stream-JSON Event Types ──────────────────────────────────────────────

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, any>;
    }>;
  };
  result?: {
    subtype?: string;
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
      // skip corrupted lines
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

export function extractFinalAssistantMessage(events: StreamEvent[]): string | null {
  let lastAssistantText: string | null = null;

  for (const event of events) {
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

export function hasAskUserQuestion(events: StreamEvent[]): boolean {
  for (const event of events) {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
          return true;
        }
      }
    }
  }
  return false;
}

export function extractAskUserQuestions(events: StreamEvent[]): AskUserQuestionData[] {
  const questions: AskUserQuestionData[] = [];

  for (const event of events) {
    if (event.type !== 'assistant' || !event.message?.content) continue;

    for (const block of event.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;

      const input = block.input;
      if (!input?.questions || !Array.isArray(input.questions)) continue;

      for (const q of input.questions) {
        questions.push({
          question: q.question ?? '',
          options: (q.options ?? []).map((o: any): AskUserQuestionOption => ({
            label: o.label ?? '',
            description: o.description ?? '',
          })),
          multiSelect: q.multiSelect ?? false,
        });
      }
    }
  }

  return questions;
}

// ── Outcome Determination ────────────────────────────────────────────────

const COMPLETION_PATTERNS = [
  /\bcommitted\b/i,
  /\bimplemented\b/i,
  /\bcompleted?\b/i,
  /\bpushed?\b/i,
  /\bfinished\b/i,
  /\ball changes have been\b/i,
  /\bsuccessfully\b/i,
  /\bcreated? (?:a )?commit\b/i,
];

const NEEDS_INPUT_PATTERNS = [
  /\bcould you\b/i,
  /\bcan you\b/i,
  /\bplease (?:clarify|provide|specify|confirm)\b/i,
  /\bunable to\b/i,
  /\bI need (?:clarification|more information|input|guidance)\b/i,
  /\bcould not (?:determine|find|resolve)\b/i,
  /\bwhich (?:approach|option|method)\b/i,
  /\bbefore I (?:can|proceed)\b/i,
  /\bwhat (?:should|would you)\b/i,
  /\bhow (?:should|would you)\b/i,
  /\bdo you (?:want|prefer)\b/i,
];

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

function messageMatchesPatterns(message: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(message));
}

function endsWithQuestion(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.endsWith('?');
}

export interface DetermineOutcomeOptions {
  permissionMode?: string;
}

export function determineOutcome(logPath: string, worktreePath: string, baseBranch: string, options?: DetermineOutcomeOptions): AgentOutcome {
  const events = parseStreamJsonLog(logPath);

  if (events.length === 0) {
    return {
      type: 'errored',
      session_id: null,
      final_message: null,
      ask_user_questions: null,
    };
  }

  const sessionId = extractSessionId(events);
  const finalMessage = extractFinalAssistantMessage(events);
  const askQuestions = extractAskUserQuestions(events);

  // Check for error in result event
  const resultEvent = events.find(e => e.type === 'result');
  if (resultEvent?.result?.subtype === 'error' || resultEvent?.subtype === 'error') {
    return {
      type: 'errored',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: null,
    };
  }

  // Check if AskUserQuestion was used
  if (askQuestions.length > 0) {
    return {
      type: 'needs-input',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: askQuestions,
    };
  }

  // Plan mode: agent ran in plan-only mode — no commits expected
  if (options?.permissionMode === '--permission-mode plan') {
    return {
      type: 'plan-completed',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: null,
    };
  }

  const hasCommits = hasCommitsBeyondBase(worktreePath, baseBranch);

  // Multi-signal heuristic
  if (hasCommits && finalMessage && messageMatchesPatterns(finalMessage, COMPLETION_PATTERNS)) {
    return {
      type: 'completed',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: null,
    };
  }

  if (!hasCommits && finalMessage && (
    messageMatchesPatterns(finalMessage, NEEDS_INPUT_PATTERNS) ||
    endsWithQuestion(finalMessage)
  )) {
    return {
      type: 'needs-input',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: null,
    };
  }

  // Commits exist but message doesn't match completion — likely completed
  if (hasCommits) {
    return {
      type: 'completed',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: null,
    };
  }

  // No commits, message doesn't clearly match either pattern
  if (finalMessage && (endsWithQuestion(finalMessage) || messageMatchesPatterns(finalMessage, NEEDS_INPUT_PATTERNS))) {
    return {
      type: 'needs-input',
      session_id: sessionId,
      final_message: finalMessage,
      ask_user_questions: null,
    };
  }

  return {
    type: 'indeterminate',
    session_id: sessionId,
    final_message: finalMessage,
    ask_user_questions: null,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────

export function formatInputRequestComment(
  outcome: AgentOutcome,
  inputRound: number,
): string {
  const parts: string[] = [
    '<!-- foundry-input-request -->',
    `**Foundry Agent — Input Needed** (round ${inputRound})`,
    '',
  ];

  if (outcome.ask_user_questions && outcome.ask_user_questions.length > 0) {
    for (let i = 0; i < outcome.ask_user_questions.length; i++) {
      const q = outcome.ask_user_questions[i];
      const selectType = q.multiSelect ? '(select multiple)' : '(select one)';
      parts.push(`**${i + 1}. ${q.question}** ${selectType}`);
      for (const opt of q.options) {
        parts.push(`- **${opt.label}** — ${opt.description}`);
      }
      parts.push('');
    }
  } else if (outcome.final_message) {
    parts.push(outcome.final_message);
    parts.push('');
  }

  parts.push('Reply with your answers. Foundry will resume the agent automatically.');

  return parts.join('\n');
}
