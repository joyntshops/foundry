/**
 * Outcome determination tests. Real temp git repos, real log files: the point
 * of this module is that it branches on facts, so the facts are real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { determineOutcome, extractFinalAssistantMessage, formatInputRequestComment } from './agent-output.js';
import { writeReportFile } from './agent-report.js';

let dir: string;
let repo: string;
let log: string;

function git(...args: string[]) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function writeLog(events: object[], extraLines: string[] = []) {
  fs.writeFileSync(log, [...extraLines, ...events.map(e => JSON.stringify(e))].join('\n') + '\n');
}

const init = { type: 'system', subtype: 'init', session_id: 'sess-1', parent_tool_use_id: null };
const say = (text: string, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const result = (extra: object) => ({ type: 'result', subtype: 'success', is_error: false, parent_tool_use_id: null, ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-outcome-'));
  repo = path.join(dir, 'repo');
  log = path.join(dir, 'agent.log');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'base');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function commit() {
  fs.appendFileSync(path.join(repo, 'a.txt'), 'b\n');
  git('commit', '-q', '-am', 'work');
}

describe('determineOutcome', () => {
  it('done + commits → completed, carrying the report', () => {
    commit();
    writeLog([init, say('All set.'), result({ structured_output: { status: 'done', summary: 'Added b.', assumptions: ['Appended.'] } })]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('completed');
    expect(o.session_id).toBe('sess-1');
    expect(o.report?.assumptions).toEqual(['Appended.']);
    expect(o.final_message).toBe('Added b.');
  });

  it('done + no commits → errored (a contradiction is never resolved by guessing)', () => {
    writeLog([init, result({ structured_output: { status: 'done', summary: 'I have successfully implemented and committed everything.' } })]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('errored');
    expect(o.reason).toMatch(/no commits/);
  });

  it('needs_input wins even when commits exist (partial work is not completion)', () => {
    commit();
    writeLog([init, result({ structured_output: {
      status: 'needs_input', summary: 'Implemented the page; tests need a decision.',
      questions: [{ question: 'Which runner?', options: [{ label: 'vitest' }, { label: 'jest' }] }],
    } })]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('needs-input');
    expect(o.ask_user_questions).toEqual([
      { question: 'Which runner?', options: [{ label: 'vitest', description: '' }, { label: 'jest', description: '' }], multiSelect: false },
    ]);
  });

  it('prose that used to fool the regexes changes nothing', () => {
    commit();
    writeLog([init, say('I have not completed this. Could you clarify which approach you prefer?'),
      result({ structured_output: { status: 'done', summary: 'Done.' } })]);
    expect(determineOutcome(log, repo, 'base').type).toBe('completed');
  });

  it('blocked → blocked with the summary as the reason', () => {
    writeLog([init, result({ structured_output: { status: 'blocked', summary: 'The registry is unreachable.' } })]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('blocked');
    expect(o.reason).toBe('The registry is unreachable.');
  });

  it('plan_ready → plan-completed with the plan as the message', () => {
    writeLog([init, result({ structured_output: { status: 'plan_ready', summary: 'Plan below.', plan: '1. A\n2. B' } })]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('plan-completed');
    expect(o.final_message).toBe('1. A\n2. B');
  });

  it('in plan mode, done means the plan is done; no commits are expected', () => {
    writeLog([init, result({ structured_output: { status: 'done', summary: 'The plan: do A then B.' } })]);
    const o = determineOutcome(log, repo, 'base', { permissionMode: '--permission-mode plan' });
    expect(o.type).toBe('plan-completed');
  });

  it('a failed run is errored regardless of any report', () => {
    commit();
    writeLog([init, { type: 'result', subtype: 'error_max_turns', is_error: true, parent_tool_use_id: null,
      structured_output: { status: 'done', summary: 'x' } }]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('errored');
    expect(o.reason).toMatch(/error_max_turns/);
  });

  it('no report → errored, with instructions', () => {
    commit();
    writeLog([init, say('Finished!'), result({})]);
    const o = determineOutcome(log, repo, 'base');
    expect(o.type).toBe('errored');
    expect(o.reason).toMatch(/without submitting a report/);
    expect(o.final_message).toMatch(/Finished!/);
  });

  it('a non-zero exit with no report names the exit code', () => {
    commit();
    fs.writeFileSync(log, '');
    const o = determineOutcome(log, repo, 'base', { exitCode: 137 });
    expect(o.type).toBe('errored');
    expect(o.reason).toBe('The agent process exited with code 137 and submitted no report.');
  });

  it('a signal death with no report says so', () => {
    fs.writeFileSync(log, '');
    expect(determineOutcome(log, repo, 'base', { exitCode: null }).reason).toMatch(/killed by a signal/);
  });

  it('a report still wins over a non-zero exit code', () => {
    commit();
    writeLog([init, result({ structured_output: { status: 'done', summary: 'ok' } })]);
    expect(determineOutcome(log, repo, 'base', { exitCode: 1 }).type).toBe('completed');
  });

  it('carries cost, turns, and duration from the result event', () => {
    commit();
    writeLog([init, result({ structured_output: { status: 'done', summary: 'ok' }, total_cost_usd: 0.4321, num_turns: 12, duration_ms: 65000 })]);
    expect(determineOutcome(log, repo, 'base').usage).toEqual({ cost_usd: 0.4321, turns: 12, duration_ms: 65000 });
  });

  it('invalid report → errored with the validation error', () => {
    writeLog([init, result({ structured_output: { status: 'maybe', summary: 'x' } })]);
    expect(determineOutcome(log, repo, 'base').reason).toMatch(/status must be one of/);
  });

  it('missing or empty log and no report file → errored', () => {
    expect(determineOutcome(path.join(dir, 'nope.log'), repo, 'base').type).toBe('errored');
  });

  it('falls back to the report file for agents with no structured output', () => {
    commit();
    fs.writeFileSync(log, 'plain text from some other agent\n');
    const reportFile = path.join(dir, 'report.json');
    writeReportFile(reportFile, { status: 'done', summary: 'aider did it.' });
    const o = determineOutcome(log, repo, 'base', { reportFile });
    expect(o.type).toBe('completed');
    expect(o.report?.summary).toBe('aider did it.');
  });

  it('structured output takes precedence over a report file', () => {
    commit();
    const reportFile = path.join(dir, 'report.json');
    writeReportFile(reportFile, { status: 'blocked', summary: 'stale' });
    writeLog([init, result({ structured_output: { status: 'done', summary: 'fresh' } })]);
    expect(determineOutcome(log, repo, 'base', { reportFile }).report?.summary).toBe('fresh');
  });

  it('ignores non-JSON lines tee\'d into the log', () => {
    commit();
    writeLog([init, result({ structured_output: { status: 'done', summary: 'ok' } })], ['Warning: no stdin data received in 3s']);
    expect(determineOutcome(log, repo, 'base').type).toBe('completed');
  });
});

describe('extractFinalAssistantMessage', () => {
  it('skips subagent text', () => {
    const events: any[] = [say('main conclusion'), say('subagent chatter', 'toolu_123')];
    expect(extractFinalAssistantMessage(events)).toBe('main conclusion');
  });
});

describe('formatInputRequestComment', () => {
  it('renders summary, questions, and options; no select hint for open questions', () => {
    const body = formatInputRequestComment({
      type: 'needs-input', session_id: null, final_message: 'ctx',
      report: { status: 'needs_input', summary: 'Two things to settle.' },
      ask_user_questions: [
        { question: 'Which runner?', options: [{ label: 'vitest', description: 'fast' }, { label: 'jest', description: '' }], multiSelect: false },
        { question: 'What should the page be called?', options: [], multiSelect: false },
      ],
    }, 1);
    expect(body).toContain('Two things to settle.');
    expect(body).toContain('**1. Which runner?** (select one)');
    expect(body).toContain('- **vitest** — fast');
    expect(body).toContain('- **jest**');
    expect(body).toMatch(/\*\*2\. What should the page be called\?\*\*\n/);
    expect(body).toContain('Reply to this issue with your answer');
  });
});
