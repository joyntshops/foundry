/**
 * Agent report — the typed contract between a coding agent and Foundry.
 *
 * Foundry never interprets an agent's prose to decide what happens next. The
 * agent ends its run by submitting a report that matches AGENT_REPORT_SCHEMA,
 * and Foundry branches on `status`. Two transports feed the same type:
 *
 *   1. Structured output. Claude Code, given `--json-schema`, validates the
 *      report itself and puts it on the final `result` event as
 *      `structured_output`. The schema is handed to the backend command in the
 *      FOUNDRY_REPORT_SCHEMA environment variable.
 *   2. A report file. Any other agent runs `foundry report ...`, which
 *      validates and writes FOUNDRY_REPORT_FILE.
 *
 * No report means no transition: the task fails closed with a reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AgentReportStatus = 'done' | 'needs_input' | 'plan_ready' | 'blocked';

export interface AgentReportOption {
  label: string;
  description?: string;
}

export interface AgentReportQuestion {
  question: string;
  options?: AgentReportOption[];
  multi_select?: boolean;
}

export interface AgentReport {
  status: AgentReportStatus;
  summary: string;
  assumptions?: string[];
  questions?: AgentReportQuestion[];
  plan?: string;
}

export const REPORT_STATUSES: AgentReportStatus[] = ['done', 'needs_input', 'plan_ready', 'blocked'];

export const REPORT_SCHEMA_ENV = 'FOUNDRY_REPORT_SCHEMA';
export const REPORT_FILE_ENV = 'FOUNDRY_REPORT_FILE';

/**
 * JSON Schema for the report. The descriptions are instructions to the agent;
 * they are the only place the meaning of each status is defined.
 */
export const AGENT_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: REPORT_STATUSES,
      description: [
        'done: the task is implemented and every change is committed.',
        'needs_input: you need a decision from a human before you can continue or finish; put it in `questions`. Commit any work in progress first.',
        'plan_ready: you were asked to plan, not implement; put the plan in `plan`.',
        'blocked: you cannot proceed and no answer from a human would unblock you (missing access, broken environment, impossible request); explain in `summary`.',
      ].join(' '),
    },
    summary: {
      type: 'string',
      description: 'What you did, or why you stopped. Written for the person reviewing the pull request. Plain prose, a few sentences.',
    },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Decisions you made without asking, one per entry, so the reviewer can check them.',
    },
    questions: {
      type: 'array',
      description: 'Required when status is needs_input. Ask only what materially changes the work; offer options when you can.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          },
          multi_select: { type: 'boolean' },
        },
        required: ['question'],
      },
    },
    plan: {
      type: 'string',
      description: 'Required when status is plan_ready. The full plan in Markdown.',
    },
  },
  required: ['status', 'summary'],
} as const;

export function reportSchemaJson(): string {
  return JSON.stringify(AGENT_REPORT_SCHEMA);
}

// ── Validation ───────────────────────────────────────────────────────────

export type ReportResult =
  | { ok: true; report: AgentReport }
  | { ok: false; error: string };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

/**
 * Validate an untrusted value as an AgentReport. Structural errors are
 * rejected. Two cross-field gaps are repaired deterministically rather than
 * rejected, because the status is unambiguous and the content exists:
 * needs_input with no questions asks the summary; plan_ready with no plan
 * uses the summary as the plan.
 */
export function validateReport(value: unknown): ReportResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'report is not an object' };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.status !== 'string' || !REPORT_STATUSES.includes(v.status as AgentReportStatus)) {
    return { ok: false, error: `status must be one of ${REPORT_STATUSES.join(', ')}` };
  }
  if (typeof v.summary !== 'string' || v.summary.trim() === '') {
    return { ok: false, error: 'summary must be a non-empty string' };
  }
  if (v.assumptions !== undefined && !isStringArray(v.assumptions)) {
    return { ok: false, error: 'assumptions must be an array of strings' };
  }
  if (v.plan !== undefined && typeof v.plan !== 'string') {
    return { ok: false, error: 'plan must be a string' };
  }

  let questions: AgentReportQuestion[] | undefined;
  if (v.questions !== undefined) {
    if (!Array.isArray(v.questions)) return { ok: false, error: 'questions must be an array' };
    questions = [];
    for (const q of v.questions) {
      if (q === null || typeof q !== 'object' || typeof (q as any).question !== 'string' || (q as any).question.trim() === '') {
        return { ok: false, error: 'each question needs a non-empty `question` string' };
      }
      const rawOptions = (q as any).options;
      let options: AgentReportOption[] | undefined;
      if (rawOptions !== undefined) {
        if (!Array.isArray(rawOptions) || !rawOptions.every((o: any) => o && typeof o.label === 'string')) {
          return { ok: false, error: 'each option needs a `label` string' };
        }
        options = rawOptions.map((o: any) => ({
          label: o.label,
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
        }));
      }
      questions.push({
        question: (q as any).question,
        ...(options ? { options } : {}),
        ...((q as any).multi_select === true ? { multi_select: true } : {}),
      });
    }
  }

  const status = v.status as AgentReportStatus;
  const summary = v.summary;

  if (status === 'needs_input' && (!questions || questions.length === 0)) {
    questions = [{ question: summary }];
  }
  let plan = v.plan as string | undefined;
  if (status === 'plan_ready' && (!plan || plan.trim() === '')) {
    plan = summary;
  }

  return {
    ok: true,
    report: {
      status,
      summary,
      ...(v.assumptions ? { assumptions: v.assumptions as string[] } : {}),
      ...(questions ? { questions } : {}),
      ...(plan ? { plan } : {}),
    },
  };
}

// ── Transports ───────────────────────────────────────────────────────────

export function reportFilePath(stateDir: string): string {
  return path.join(stateDir, 'report.json');
}

/** Read and validate a report file. Null when the file does not exist. */
export function readReportFile(file: string): ReportResult | null {
  if (!fs.existsSync(file)) return null;
  try {
    return validateReport(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err: any) {
    return { ok: false, error: `report file is not valid JSON: ${err.message}` };
  }
}

export function writeReportFile(file: string, report: AgentReport): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Environment for an agent launch, and a clean slate: a report left by a
 * previous launch of the same task must never be read as this launch's.
 */
export function prepareLaunch(stateDir: string): Record<string, string> {
  const file = reportFilePath(stateDir);
  try { fs.rmSync(file, { force: true }); } catch {}
  return {
    [REPORT_SCHEMA_ENV]: reportSchemaJson(),
    [REPORT_FILE_ENV]: file,
  };
}
