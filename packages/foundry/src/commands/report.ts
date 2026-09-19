/**
 * foundry report — how an agent that cannot produce structured output tells
 * Foundry what happened. Validates, then writes the report file that
 * `foundry action` reads when the agent exits. Exits non-zero with a precise
 * message on invalid input so the agent can correct itself and retry.
 *
 *   foundry report --status done --summary "Added the Spanish greeting." \
 *     --assumption "Placed it after the English line."
 *
 *   foundry report --status needs_input --summary "Two layouts are possible." \
 *     --question "Which layout? | Table; List"
 */
import * as fs from 'node:fs';
import { validateReport, writeReportFile, REPORT_FILE_ENV, type AgentReportQuestion } from '../lib/agent-report.js';

export interface ReportOptions {
  status: string;
  summary: string;
  assumption?: string[];
  question?: string[];
  plan?: string;
  planFile?: string;
  file?: string;
}

/** "Which layout? | Table; List" → { question, options }. */
export function parseQuestionArg(arg: string): AgentReportQuestion {
  const bar = arg.indexOf(' | ');
  if (bar === -1) return { question: arg.trim() };
  const options = arg.slice(bar + 3).split(';').map(o => o.trim()).filter(Boolean).map(label => ({ label }));
  return { question: arg.slice(0, bar).trim(), ...(options.length > 0 ? { options } : {}) };
}

export async function runReport(opts: ReportOptions): Promise<void> {
  const file = opts.file ?? process.env[REPORT_FILE_ENV];
  if (!file) {
    console.error(`foundry report: no destination. Pass --file or set ${REPORT_FILE_ENV}.`);
    process.exit(2);
  }

  let plan = opts.plan;
  if (opts.planFile) {
    try {
      plan = fs.readFileSync(opts.planFile, 'utf-8');
    } catch (err: any) {
      console.error(`foundry report: cannot read --plan-file: ${err.message}`);
      process.exit(2);
    }
  }

  const candidate = {
    status: opts.status,
    summary: opts.summary,
    ...(opts.assumption && opts.assumption.length > 0 ? { assumptions: opts.assumption } : {}),
    ...(opts.question && opts.question.length > 0 ? { questions: opts.question.map(parseQuestionArg) } : {}),
    ...(plan ? { plan } : {}),
  };

  const result = validateReport(candidate);
  if (!result.ok) {
    console.error(`foundry report: ${result.error}`);
    process.exit(2);
  }

  writeReportFile(file, result.report);
  console.log(`Report recorded: ${result.report.status}`);
}
