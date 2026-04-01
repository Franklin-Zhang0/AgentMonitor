import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentStore } from '../src/store/AgentStore.js';
import { AgentManager } from '../src/services/AgentManager.js';
import type { Agent } from '../src/models/Agent.js';

describe('AgentManager deleteAgent purgeSessionFiles', () => {
  let tmpDir: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let store: AgentStore;
  let manager: AgentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delete-test-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delete-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    store = new AgentStore(tmpDir);
    manager = new AgentManager(store);
  });

  afterEach(() => {
    const stuckCheckInterval = (manager as unknown as { stuckCheckInterval?: ReturnType<typeof setInterval> | null }).stuckCheckInterval;
    if (stuckCheckInterval) clearInterval(stuckCheckInterval);
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('purges claude session jsonl by exact sessionId', async () => {
    const sessionId = 'claude-session-123';
    const claudeSessionDir = path.join(tmpHome, '.claude', 'projects', 'test-project');
    fs.mkdirSync(claudeSessionDir, { recursive: true });
    const sessionPath = path.join(claudeSessionDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionPath, '{"type":"session_meta"}\n');

    const agent: Agent = {
      id: 'agent-claude-delete',
      name: 'Claude Delete',
      status: 'stopped',
      config: {
        provider: 'claude',
        directory: tmpDir,
        prompt: 'x',
        flags: {},
      },
      messages: [],
      lastActivity: Date.now(),
      createdAt: Date.now(),
      sessionId,
      source: 'monitor',
    };
    store.saveAgent(agent);

    await manager.deleteAgent(agent.id, { purgeSessionFiles: true });

    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it('purges only exact codex jsonl files matching sessionId suffix', async () => {
    const sessionId = '019d5000-aaaa-7bbb-8ccc-112233445566';
    const codexSessionDir = path.join(tmpHome, '.codex', 'sessions', '2026', '04', '01');
    fs.mkdirSync(codexSessionDir, { recursive: true });

    const exactPath = path.join(codexSessionDir, `rollout-2026-04-01T12-00-00-${sessionId}.jsonl`);
    const decoyPath = path.join(codexSessionDir, `rollout-2026-04-01T12-00-00-${sessionId}-extra.jsonl`);
    fs.writeFileSync(exactPath, '{"type":"session_meta"}\n');
    fs.writeFileSync(decoyPath, '{"type":"session_meta"}\n');

    const agent: Agent = {
      id: 'agent-codex-delete',
      name: 'Codex Delete',
      status: 'stopped',
      config: {
        provider: 'codex',
        directory: tmpDir,
        prompt: 'x',
        flags: {},
      },
      messages: [],
      lastActivity: Date.now(),
      createdAt: Date.now(),
      sessionId,
      source: 'monitor',
    };
    store.saveAgent(agent);

    await manager.deleteAgent(agent.id, { purgeSessionFiles: true });

    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(fs.existsSync(exactPath)).toBe(false);
    expect(fs.existsSync(decoyPath)).toBe(true);
  });
});
