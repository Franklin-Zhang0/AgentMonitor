import { describe, expect, it } from 'vitest';
import { RuntimeCapabilitiesService } from '../src/services/RuntimeCapabilities.js';

interface MockResult {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: Error;
}

function createService(results: Record<string, MockResult>) {
  return new RuntimeCapabilitiesService((bin, args) => {
    const key = args.join(' ');
    const normalizedBin = bin.includes('codex')
      ? 'codex'
      : bin.includes('claude')
        ? 'claude'
        : bin;
    const result = results[`${normalizedBin} ${key}`] || results[key] || {};
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status ?? 0,
      error: result.error,
    };
  }, 0);
}

describe('RuntimeCapabilitiesService', () => {
  it('parses Claude effort values from installed help output', () => {
    const service = createService({
      'claude --version': { stdout: '2.1.70 (Claude Code)' },
      'claude --help': { stdout: '--effort <level>  Effort level for the current session (low, medium, high)' },
      'codex --version': { stdout: 'codex-cli 0.117.0' },
    });

    const capabilities = service.getCapabilities(true);
    expect(capabilities.providers.claude.version).toBe('2.1.70');
    expect(capabilities.providers.claude.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(capabilities.providers.claude.models).toEqual(['sonnet', 'opus']);
    expect(capabilities.providers.claude.detectedFrom).toBe('help');
  });

  it('keeps Claude max only when the installed help output exposes it', () => {
    const service = createService({
      'claude --version': { stdout: '2.2.0 (Claude Code)' },
      'claude --help': { stdout: '--effort <level>  Effort level for the current session (low, medium, high, max)\n--model <model>  Model for the current session. Provide an alias for the latest model (e.g. \'sonnet\' or \'opus\') or a model\'s full name (e.g. \'claude-sonnet-4-6\').' },
      'codex --version': { stdout: 'codex-cli 0.117.0' },
    });

    const capabilities = service.getCapabilities(true);
    expect(capabilities.providers.claude.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(capabilities.providers.claude.models).toEqual(['sonnet', 'opus', 'claude-sonnet-4-6']);
  });

  it('uses a Codex version threshold before exposing xhigh', () => {
    const newService = createService({
      'claude --version': { stdout: '2.1.70 (Claude Code)' },
      'claude --help': { stdout: '--effort <level>  Effort level for the current session (low, medium, high)' },
      'codex --version': { stdout: 'codex-cli 0.117.0' },
    });
    expect(newService.getCapabilities(true).providers.codex.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(newService.getCapabilities(true).providers.codex.models).toEqual(['gpt-5', 'gpt-5.4', 'gpt-5.4-mini']);

    const oldService = createService({
      'claude --version': { stdout: '2.1.70 (Claude Code)' },
      'claude --help': { stdout: '--effort <level>  Effort level for the current session (low, medium, high)' },
      'codex --version': { stdout: 'codex-cli 0.90.0' },
    });
    expect(oldService.getCapabilities(true).providers.codex.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(oldService.getCapabilities(true).providers.codex.models).toEqual(['gpt-5']);
  });

  it('normalizes unsupported reasoning effort values away', () => {
    const service = createService({
      'claude --version': { stdout: '2.1.70 (Claude Code)' },
      'claude --help': { stdout: '--effort <level>  Effort level for the current session (low, medium, high)' },
      'codex --version': { stdout: 'codex-cli 0.117.0' },
    });

    expect(service.normalizeReasoningEffort('claude', 'max')).toBeUndefined();
    expect(service.normalizeReasoningEffort('claude', 'high')).toBe('high');
  });
});
