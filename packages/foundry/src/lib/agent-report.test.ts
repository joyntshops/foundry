import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateReport, readReportFile, writeReportFile, prepareLaunch, reportFilePath,
  reportSchemaJson, REPORT_SCHEMA_ENV, REPORT_FILE_ENV,
} from './agent-report.js';

describe('validateReport', () => {
  it('accepts a minimal done report', () => {
    const r = validateReport({ status: 'done', summary: 'Added the line.' });
    expect(r).toEqual({ ok: true, report: { status: 'done', summary: 'Added the line.' } });
  });

  it('keeps assumptions, questions with options, and multi_select', () => {
    const r = validateReport({
      status: 'needs_input',
      summary: 'Two layouts are possible.',
      assumptions: ['Kept the existing order.'],
      questions: [{ question: 'Which layout?', options: [{ label: 'Table', description: 'Dense' }, { label: 'List' }], multi_select: true }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.assumptions).toEqual(['Kept the existing order.']);
    expect(r.report.questions).toEqual([
      { question: 'Which layout?', options: [{ label: 'Table', description: 'Dense' }, { label: 'List' }], multi_select: true },
    ]);
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['unknown status', { status: 'finished', summary: 'x' }],
    ['missing summary', { status: 'done' }],
    ['blank summary', { status: 'done', summary: '   ' }],
    ['assumptions not strings', { status: 'done', summary: 'x', assumptions: [1] }],
    ['question without text', { status: 'needs_input', summary: 'x', questions: [{ options: [] }] }],
    ['option without label', { status: 'needs_input', summary: 'x', questions: [{ question: 'q', options: [{}] }] }],
    ['plan not a string', { status: 'plan_ready', summary: 'x', plan: 5 }],
  ])('rejects %s', (_name, value) => {
    expect(validateReport(value).ok).toBe(false);
  });

  it('asks the summary when needs_input carries no questions', () => {
    const r = validateReport({ status: 'needs_input', summary: 'Which file did you mean?' });
    expect(r.ok && r.report.questions).toEqual([{ question: 'Which file did you mean?' }]);
  });

  it('uses the summary as the plan when plan_ready carries no plan', () => {
    const r = validateReport({ status: 'plan_ready', summary: '1. Do it.' });
    expect(r.ok && r.report.plan).toBe('1. Do it.');
  });

  it('drops unknown fields instead of passing them through', () => {
    const r = validateReport({ status: 'done', summary: 'x', sneaky: 'rm -rf' });
    expect(r.ok && Object.keys(r.report)).toEqual(['status', 'summary']);
  });
});

describe('report file transport', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-report-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when there is no file', () => {
    expect(readReportFile(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('round-trips a report', () => {
    const file = reportFilePath(dir);
    writeReportFile(file, { status: 'blocked', summary: 'No network.' });
    expect(readReportFile(file)).toEqual({ ok: true, report: { status: 'blocked', summary: 'No network.' } });
  });

  it('reports invalid JSON as an error, not a crash', () => {
    const file = reportFilePath(dir);
    fs.writeFileSync(file, '{not json');
    const r = readReportFile(file);
    expect(r && r.ok).toBe(false);
  });

  it('prepareLaunch clears a stale report and returns the contract env', () => {
    const file = reportFilePath(dir);
    writeReportFile(file, { status: 'done', summary: 'from the previous launch' });

    const env = prepareLaunch(dir);

    expect(fs.existsSync(file)).toBe(false);
    expect(env[REPORT_FILE_ENV]).toBe(file);
    expect(env[REPORT_SCHEMA_ENV]).toBe(reportSchemaJson());
    expect(JSON.parse(env[REPORT_SCHEMA_ENV]).properties.status.enum).toEqual(['done', 'needs_input', 'plan_ready', 'blocked']);
  });
});
