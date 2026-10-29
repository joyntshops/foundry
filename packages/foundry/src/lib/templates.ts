/**
 * Files Foundry ships for a target repo: the workflow template and example
 * scripts. They live under packages/foundry/templates/ (published with the
 * package) and are read at runtime, so the docs can link the same files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Absolute path of the templates directory, from dist/ or src/. */
export function templatesDir(): string {
  // dist/lib/templates.js → ../../templates ; src/lib/templates.ts → ../../templates
  return path.resolve(__dirname, '..', '..', 'templates');
}

export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(templatesDir(), name), 'utf-8');
}

/** The workflow template with the repo's production branch substituted. */
export function renderWorkflow(template: string, opts: { production: string }): string {
  return template.replaceAll('__PRODUCTION_BRANCH__', opts.production);
}
