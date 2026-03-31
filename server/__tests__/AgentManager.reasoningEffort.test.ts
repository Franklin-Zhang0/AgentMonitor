import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentStore } from '../src/store/AgentStore.js';
import { AgentManager } from '../src/services/AgentManager.js';
import { AgentProcess } from '../src/services/AgentProcess.js';
import type { Agent } from '../src/models/Agent.js';

describe('reasoning effort support', () => {
  let tmpDir: string;
  let store: AgentStore;
  let manager: AgentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-effort-test-'));
    store = new AgentStore(tmpDir);
    manager = new AgentManager(store);
  });

  afterEach(() => {
    const stuckCheckInterval = (manager as unknown as { stuckCheckInterval?: ReturnType<typeof setInterval> | null }).stuckCheckInterval;
    if (stuckCheckInterval) clearInterval(stuckCheckInterval);
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates reasoning effort on an existing codex agent', () => {
    const agent: Agent = {
      id: 'agent-1',
      name: 'Effort Test',
      status: 'stopped',
      config: {
        provider: 'codex',
        directory: tmpDir,
        prompt: 'original prompt',
        flags: {},
      },
      messages: [],
      lastActivity: 1,
      createdAt: 1,
    };
    store.saveAgent(agent);

    manager.updateReasoningEffort(agent.id, 'xhigh');
    expect(store.getAgent(agent.id)?.config.flags.reasoningEffort).toBe('xhigh');

    manager.updateReasoningEffort(agent.id, undefined);
    expect(store.getAgent(agent.id)?.config.flags.reasoningEffort).toBeUndefined();
  });

  it('passes reasoning effort to Codex via config override', () => {
    const proc = new AgentProcess();
    const buildCodexCommand = (proc as unknown as {
      buildCodexCommand: (opts: {
        provider: 'codex';
        directory: string;
        prompt: string;
        model?: string;
        reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
      }) => { bin: string; args: string[] };
    }).buildCodexCommand.bind(proc);

    const { args } = buildCodexCommand({
      provider: 'codex',
      directory: tmpDir,
      prompt: 'ping',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });

    expect(args).toContain('-c');
    expect(args).toContain('\'model_reasoning_effort="high"\'');
  });

  it('passes reasoning effort to Claude via --effort', () => {
    const proc = new AgentProcess();
    const buildClaudeCommand = (proc as unknown as {
      buildClaudeCommand: (opts: {
        provider: 'claude';
        directory: string;
        prompt: string;
        reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
      }) => { bin: string; args: string[] };
    }).buildClaudeCommand.bind(proc);

    const { args } = buildClaudeCommand({
      provider: 'claude',
      directory: tmpDir,
      prompt: 'ping',
      reasoningEffort: 'max',
    });

    expect(args).toContain('--effort');
    expect(args).toContain('\'max\'');
  });
});
