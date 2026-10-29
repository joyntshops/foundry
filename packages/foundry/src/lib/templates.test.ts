import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readTemplate, renderWorkflow, templatesDir } from './templates.js';

describe('shipped templates', () => {
  it('finds the templates directory from src and dist alike', () => {
    expect(fs.existsSync(path.join(templatesDir(), 'foundry.yml'))).toBe(true);
    expect(fs.existsSync(path.join(templatesDir(), 'vercel-preview-url.sh'))).toBe(true);
  });

  it('the workflow template is valid YAML with every trigger Foundry needs', () => {
    const wf = parseYaml(readTemplate('foundry.yml'));
    expect(Object.keys(wf.on)).toEqual(['issue_comment', 'pull_request', 'pull_request_review', 'workflow_dispatch', 'schedule']);
    expect(wf.on.workflow_dispatch.inputs).toHaveProperty('issue');
    expect(wf.on.workflow_dispatch.inputs).toHaveProperty('command');
    expect(wf.permissions).toMatchObject({ contents: 'write', issues: 'write', 'pull-requests': 'write', checks: 'write', actions: 'write' });
    expect(wf.jobs.foundry.concurrency.group).toContain('foundry-');
    expect(wf.jobs.foundry.steps.map((s: any) => s.uses ?? s.name)).toContain('joyntshops/foundry@main');
  });

  it('renders the production branch into the PR filter and leaves no placeholder', () => {
    const out = renderWorkflow(readTemplate('foundry.yml'), { production: 'release' });
    expect(out).toContain("github.event.pull_request.base.ref == 'release'");
    expect(out).not.toContain('__PRODUCTION_BRANCH__');
  });
});
