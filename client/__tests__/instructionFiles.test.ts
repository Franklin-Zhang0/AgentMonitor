import { describe, expect, it } from 'vitest';
import { getInstructionFileName, replaceInstructionFileName } from '../src/lib/instructionFiles';

describe('instructionFiles', () => {
  it('returns the correct provider-specific file name', () => {
    expect(getInstructionFileName('claude')).toBe('CLAUDE.md');
    expect(getInstructionFileName('codex')).toBe('AGENTS.md');
  });

  it('replaces CLAUDE.md labels with the target instruction file name', () => {
    expect(replaceInstructionFileName('Load existing CLAUDE.md', 'AGENTS.md'))
      .toBe('Load existing AGENTS.md');
  });
});
