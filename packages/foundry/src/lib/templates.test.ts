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
    expect(wf.permissions).toMatchObject({ contents: 'write', issues: 'write', 'pull-requests': 'write', checks: 'write', actions: 'write', 'id-token': 'write' });
    expect(wf.jobs.foundry.concurrency.group).toContain('foundry-');
    expect(wf.jobs.foundry.steps.map((s: any) => s.uses ?? s.name)).toContain('joyntshops/foundry@v0');
  });

  it('the comment filter lets every command through on issues and only the preview command on pull requests', () => {
    const wf = parseYaml(readTemplate('foundry.yml'));
    const filter: string = wf.jobs.foundry.if;
    expect(filter).toContain("startsWith(github.event.comment.body, '@foundry')");
    expect(filter).toContain("(!github.event.issue.pull_request || startsWith(github.event.comment.body, '@foundry preview'))");
    // Still gated on who is commenting, before a runner starts.
    expect(filter).toContain('github.event.comment.author_association');
    expect(wf.on.workflow_dispatch.inputs.command.description).toContain('preview');
  });

  it('renders the production branch into the PR filter and leaves no placeholder', () => {
    const out = renderWorkflow(readTemplate('foundry.yml'), { production: 'release' });
    expect(out).toContain("github.event.pull_request.base.ref == 'release'");
    expect(out).not.toContain('__PRODUCTION_BRANCH__');
  });
});
