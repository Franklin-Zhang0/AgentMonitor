import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentStore } from '../src/store/AgentStore.js';
import { AgentManager } from '../src/services/AgentManager.js';
import type { Agent } from '../src/models/Agent.js';

describe('AgentManager rewind flow', () => {
  let tmpDir: string;
  let store: AgentStore;
  let manager: AgentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-manager-rewind-'));
    store = new AgentStore(tmpDir);
    manager = new AgentManager(store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuilds the preserved transcript after rewind instead of resuming the discarded session', async () => {
    const targetMessageId = 'user-2';
    const agent: Agent = {
      id: 'agent-1',
      name: 'Test Agent',
      status: 'running',
      config: {
        provider: 'claude',
        directory: tmpDir,
        prompt: 'Original task',
        flags: {
          resume: 'session-1',
        },
      },
      messages: [
        { id: 'user-1', role: 'user', content: 'First prompt', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'First answer', timestamp: 2 },
        { id: targetMessageId, role: 'user', content: 'Second prompt', timestamp: 3 },
        { id: 'assistant-2', role: 'assistant', content: 'Second answer', timestamp: 4 },
      ],
      lastActivity: Date.now(),
      createdAt: Date.now(),
      sessionId: 'session-1',
    };
    store.saveAgent(agent);

    await manager.rewindToMessage(agent.id, targetMessageId);

    const rewound = store.getAgent(agent.id);
    expect(rewound?.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(rewound?.sessionId).toBeUndefined();
    expect(rewound?.config.flags.resume).toBeUndefined();

    const resumeSpy = vi.spyOn(manager as never, 'resumeAgent' as never).mockImplementation(() => {});
    const startProcessSpy = vi.spyOn(manager as never, 'startProcess' as never).mockImplementation(() => {});
    const updateStatusSpy = vi.spyOn(manager as never, 'updateAgentStatus' as never);

    manager.sendMessage(agent.id, 'Second prompt edited');

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(updateStatusSpy).toHaveBeenCalledWith(agent.id, 'running');
    expect(startProcessSpy).toHaveBeenCalledTimes(1);

    const replayPrompt = startProcessSpy.mock.calls[0]?.[1];
    expect(typeof replayPrompt).toBe('string');
    expect(replayPrompt).toContain('Original task: Original task');
    expect(replayPrompt).toContain('USER: First prompt');
    expect(replayPrompt).toContain('ASSISTANT: First answer');
    expect(replayPrompt).toContain('USER: Second prompt edited');
    expect(replayPrompt).not.toContain('Second answer');
  });
});
