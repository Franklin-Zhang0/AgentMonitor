import type { AgentProvider } from '../api/client';

export const INSTRUCTION_FILE_BY_PROVIDER: Record<AgentProvider, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
};

export function getInstructionFileName(provider: AgentProvider): string {
  return INSTRUCTION_FILE_BY_PROVIDER[provider];
}

export function replaceInstructionFileName(text: string, fileName: string): string {
  return text.replace(/CLAUDE\.md/g, fileName);
}
