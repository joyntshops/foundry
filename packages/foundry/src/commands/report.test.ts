import { describe, it, expect } from 'vitest';
import { parseQuestionArg } from './report.js';

describe('parseQuestionArg', () => {
  it('parses a bare question', () => {
    expect(parseQuestionArg('Which file?')).toEqual({ question: 'Which file?' });
  });
  it('parses options after " | "', () => {
    expect(parseQuestionArg('Which layout? | Table; List ;')).toEqual({
      question: 'Which layout?', options: [{ label: 'Table' }, { label: 'List' }],
    });
  });
});
