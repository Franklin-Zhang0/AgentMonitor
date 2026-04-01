import { spawnSync } from 'child_process';
import { config } from '../config.js';
import type { AgentProvider, ReasoningEffort } from '../models/Agent.js';
import { isReasoningEffort } from '../models/Agent.js';

type DetectionSource = 'help' | 'version-threshold' | 'fallback' | 'unavailable';

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export interface ProviderRuntimeCapabilities {
  available: boolean;
  version?: string;
  reasoningEfforts: ReasoningEffort[];
  detectedFrom: DetectionSource;
}

export interface RuntimeCapabilities {
  checkedAt: number;
  providers: Record<AgentProvider, ProviderRuntimeCapabilities>;
}

type CommandRunner = (bin: string, args: string[]) => CommandResult;

const CACHE_TTL_MS = 60_000;
const DEFAULT_CLAUDE_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];
const DEFAULT_CODEX_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];
const CODEX_XHIGH_MIN_VERSION = '0.117.0';

function runCommand(bin: string, args: string[]): CommandResult {
  const result = spawnSync(bin, args, {
    encoding: 'utf-8',
    timeout: 5000,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    error: result.error ? new Error(String(result.error.message || result.error)) : undefined,
  };
}

function parseVersion(text: string): string | undefined {
  return text.match(/\b\d+\.\d+\.\d+\b/)?.[0];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => parseInt(part, 10));
  const rightParts = right.split('.').map((part) => parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function uniqueEfforts(values: string[]): ReasoningEffort[] {
  const seen = new Set<ReasoningEffort>();
  const efforts: ReasoningEffort[] = [];

  for (const value of values) {
    if (!isReasoningEffort(value) || seen.has(value)) continue;
    seen.add(value);
    efforts.push(value);
  }

  return efforts;
}

export class RuntimeCapabilitiesService {
  private cache?: RuntimeCapabilities;
  private cacheAt = 0;

  constructor(
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly cacheTtlMs = CACHE_TTL_MS,
  ) {}

  getCapabilities(forceRefresh = false): RuntimeCapabilities {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.cacheAt < this.cacheTtlMs) {
      return this.cache;
    }

    this.cache = {
      checkedAt: now,
      providers: {
        claude: this.detectClaude(),
        codex: this.detectCodex(),
      },
    };
    this.cacheAt = now;

    return this.cache;
  }

  getSupportedReasoningEfforts(provider: AgentProvider): ReasoningEffort[] {
    return this.getCapabilities().providers[provider].reasoningEfforts;
  }

  isReasoningEffortSupported(provider: AgentProvider, effort: unknown): effort is ReasoningEffort {
    return typeof effort === 'string' && this.getSupportedReasoningEfforts(provider).includes(effort as ReasoningEffort);
  }

  normalizeReasoningEffort(provider: AgentProvider, effort: unknown): ReasoningEffort | undefined {
    return this.isReasoningEffortSupported(provider, effort) ? effort : undefined;
  }

  private detectClaude(): ProviderRuntimeCapabilities {
    const versionResult = this.commandRunner(config.claudeBin, ['--version']);
    const helpResult = this.commandRunner(config.claudeBin, ['--help']);
    const version = parseVersion([versionResult.stdout, versionResult.stderr].join('\n'));
    const helpText = [helpResult.stdout, helpResult.stderr].join('\n');
    const reasoningEfforts = this.parseClaudeEfforts(helpText);

    if (reasoningEfforts.length > 0) {
      return {
        available: true,
        version,
        reasoningEfforts,
        detectedFrom: 'help',
      };
    }

    const available = !versionResult.error || !helpResult.error;
    if (!available) {
      return {
        available: false,
        version,
        reasoningEfforts: [],
        detectedFrom: 'unavailable',
      };
    }

    return {
      available: true,
      version,
      reasoningEfforts: DEFAULT_CLAUDE_REASONING_EFFORTS,
      detectedFrom: 'fallback',
    };
  }

  private detectCodex(): ProviderRuntimeCapabilities {
    const versionResult = this.commandRunner(config.codexBin, ['--version']);
    const versionText = [versionResult.stdout, versionResult.stderr].join('\n');
    const version = parseVersion(versionText);

    if (versionResult.error && !version) {
      return {
        available: false,
        version,
        reasoningEfforts: [],
        detectedFrom: 'unavailable',
      };
    }

    const reasoningEfforts: ReasoningEffort[] = version && compareVersions(version, CODEX_XHIGH_MIN_VERSION) >= 0
      ? [...DEFAULT_CODEX_REASONING_EFFORTS, 'xhigh']
      : [...DEFAULT_CODEX_REASONING_EFFORTS];

    return {
      available: true,
      version,
      reasoningEfforts,
      detectedFrom: version ? 'version-threshold' : 'fallback',
    };
  }

  private parseClaudeEfforts(helpText: string): ReasoningEffort[] {
    const effortLine = helpText
      .split('\n')
      .find((line) => line.includes('--effort'));

    if (!effortLine) return [];

    return uniqueEfforts(effortLine.match(/\b(low|medium|high|xhigh|max)\b/g) || []);
  }
}

export const runtimeCapabilities = new RuntimeCapabilitiesService();
