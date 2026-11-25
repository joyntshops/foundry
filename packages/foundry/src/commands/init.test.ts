import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_PATH, writeSkill } from './init.js';
import { readTemplate } from '../lib/templates.js';

describe('foundry init: the Claude Code skill', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-init-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('writes the shipped skill to .claude/skills/foundry/SKILL.md', () => {
    writeSkill(root);
    const written = fs.readFileSync(path.join(root, '.claude', 'skills', 'foundry', 'SKILL.md'), 'utf-8');
    expect(SKILL_PATH).toBe(path.join('.claude', 'skills', 'foundry', 'SKILL.md'));
    expect(written).toBe(readTemplate(path.join('skills', 'foundry', 'SKILL.md')));
    expect(written).toMatch(/^---\nname: foundry\ndescription: .+\n---\n/);
  });

  it('never overwrites an existing skill file', () => {
    const file = path.join(root, SKILL_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'local edits', 'utf-8');
    writeSkill(root);
    expect(fs.readFileSync(file, 'utf-8')).toBe('local edits');
  });
});
