import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentStore } from '../src/store/AgentStore.js';
import { AgentManager } from '../src/services/AgentManager.js';
import type { Agent } from '../src/models/Agent.js';

describe('AgentManager', () => {
  let tmpDir: string;
  let store: AgentStore;
  let manager: AgentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-test-'));
    store = new AgentStore(tmpDir);
    manager = new AgentManager(store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Claude permission prompts with "requested permissions" wording', () => {
    const agent: Agent = {
      id: 'agent-1',
      name: 'Test Agent',
      status: 'running',
      config: {
        provider: 'claude',
        directory: tmpDir,
        prompt: 'test',
        flags: {},
      },
      messages: [],
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    store.saveAgent(agent);

    const inputEvents: Array<{ prompt: string; choices?: string[] }> = [];
    manager.on('agent:input_required', (_agentId: string, inputInfo: { prompt: string; choices?: string[] }) => {
      inputEvents.push(inputInfo);
    });

    (manager as any).handleClaudeMessage(agent, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: "Claude requested permissions to write to /home/happy/project/test/test.md, but you haven't granted it yet.",
          },
        ],
      },
    });

    expect(store.getAgent(agent.id)?.status).toBe('waiting_input');
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]?.prompt).toContain('requested permissions');
    expect(inputEvents[0]?.choices).toEqual(['Allow', 'Deny', 'Always allow']);
  });

  it('detects Claude permission prompts for non-write requests', () => {
    const agent: Agent = {
      id: 'agent-2',
      name: 'Test Agent',
      status: 'running',
      config: {
        provider: 'claude',
        directory: tmpDir,
        prompt: 'test',
        flags: {},
      },
      messages: [],
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    store.saveAgent(agent);

    const inputEvents: Array<{ prompt: string; choices?: string[] }> = [];
    manager.on('agent:input_required', (_agentId: string, inputInfo: { prompt: string; choices?: string[] }) => {
      inputEvents.push(inputInfo);
    });

    (manager as any).handleClaudeMessage(agent, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: "Claude requested permissions to use Bash, but you haven't granted it yet.",
          },
        ],
      },
    });

    expect(store.getAgent(agent.id)?.status).toBe('waiting_input');
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]?.prompt).toContain('requested permissions');
    expect(inputEvents[0]?.choices).toEqual(['Allow', 'Deny', 'Always allow']);
  });
});
