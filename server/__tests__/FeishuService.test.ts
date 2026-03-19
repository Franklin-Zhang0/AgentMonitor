import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

// ── Mock @larksuiteoapi/node-sdk ─────────────────────────────────────────────
vi.mock('@larksuiteoapi/node-sdk', () => {
  const EventDispatcher = class {
    handlers: Record<string, Function> = {};
    register(handlers: Record<string, Function>) {
      Object.assign(this.handlers, handlers);
      return this;
    }
    async dispatch(eventType: string, data: any) {
      if (this.handlers[eventType]) return this.handlers[eventType](data);
    }
  };
  const Client = class {
    im = {
      v1: {
        message: {
          create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_001' } }),
          patch: vi.fn().mockResolvedValue({}),
        },
      },
    };
  };
  const WSClient = class {
    async start(_opts: any) {}
    stop() {}
  };
  return { Client, WSClient, EventDispatcher };
});

import { FeishuService } from '../src/services/FeishuService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

class MockAgentManager extends EventEmitter {
  private agents: Map<string, any> = new Map();

  addAgent(agent: any) {
    this.agents.set(agent.id, agent);
  }

  getAgent(id: string) {
    return this.agents.get(id) ?? null;
  }

  getAllAgents() {
    return [...this.agents.values()];
  }

  stopAgent = vi.fn().mockResolvedValue(undefined);
  sendMessage = vi.fn().mockResolvedValue(undefined);
}

function makeAgent(overrides: any = {}) {
  return {
    id: 'agent-1234',
    name: 'Test Agent',
    status: 'running',
    config: { provider: 'claude', directory: '/tmp', prompt: 'do it', flags: {} },
    messages: [],
    lastActivity: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeSvc(overrides: any = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-'));
  const manager = new MockAgentManager();
  const svc = new FeishuService(
    {
      appId: 'test-app-id',
      appSecret: 'test-secret',
      allowedUsers: [],
      bindingsFile: path.join(tmpDir, 'bindings.json'),
      ...overrides.cfgOverrides,
    },
    manager as any,
  );
  return { svc, manager, tmpDir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FeishuService - sendCard / sendText', () => {
  it('sendCard returns null when client not initialized', async () => {
    const { svc } = makeSvc();
    const result = await svc.sendCard('chat1', '{}');
    expect(result).toBeNull();
  });

  it('sendText does nothing when client not initialized', async () => {
    const { svc } = makeSvc();
    await expect(svc.sendText('chat1', 'hello')).resolves.toBeUndefined();
  });
});

describe('FeishuService - handleMessage', () => {
  let svc: FeishuService;
  let manager: MockAgentManager;
  let tmpDir: string;

  beforeEach(async () => {
    ({ svc, manager, tmpDir } = makeSvc());
    // Start service so client is initialized
    await svc.start();
    // Spy sendCard/sendText after start
    vi.spyOn(svc, 'sendCard').mockResolvedValue('msg_mock');
    vi.spyOn(svc, 'sendText').mockResolvedValue(undefined);
  });

  afterEach(() => {
    svc.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEvent(text: string, chatId = 'chat1', openId = 'user1') {
    return {
      sender: { sender_id: { open_id: openId } },
      message: {
        chat_id: chatId,
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    };
  }

  it('/help sends help card', async () => {
    await svc.handleMessage(makeEvent('/help'));
    expect(svc.sendCard).toHaveBeenCalledWith('chat1', expect.stringContaining('/list'));
  });

  it('/list sends agent list card', async () => {
    manager.addAgent(makeAgent());
    await svc.handleMessage(makeEvent('/list'));
    expect(svc.sendCard).toHaveBeenCalled();
    const card = JSON.parse((svc.sendCard as any).mock.calls[0][1]);
    expect(JSON.stringify(card)).toContain('Test Agent');
  });

  it('/attach binds agent by name', async () => {
    manager.addAgent(makeAgent({ id: 'agent-1234', name: 'My Bot' }));
    await svc.handleMessage(makeEvent('/attach My Bot'));
    const binding = svc.getBindings().get('chat1');
    expect(binding?.agentId).toBe('agent-1234');
    expect(svc.sendCard).toHaveBeenCalled();
  });

  it('/attach shows error for unknown agent', async () => {
    await svc.handleMessage(makeEvent('/attach nonexistent'));
    expect(svc.sendCard).toHaveBeenCalledWith('chat1', expect.stringContaining('找不到'));
  });

  it('/attach with no arg shows usage', async () => {
    await svc.handleMessage(makeEvent('/attach'));
    expect(svc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('用法'));
  });

  it('/detach removes binding', async () => {
    manager.addAgent(makeAgent({ id: 'agent-1234', name: 'My Bot' }));
    await svc.handleMessage(makeEvent('/attach My Bot'));
    await svc.handleMessage(makeEvent('/detach'));
    expect(svc.getBindings().has('chat1')).toBe(false);
  });

  it('/detach on unbound chat shows message', async () => {
    await svc.handleMessage(makeEvent('/detach'));
    expect(svc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('没有绑定'));
  });

  it('/stop calls manager.stopAgent', async () => {
    manager.addAgent(makeAgent({ id: 'agent-1234', name: 'My Bot' }));
    await svc.handleMessage(makeEvent('/attach My Bot'));
    await svc.handleMessage(makeEvent('/stop'));
    expect(manager.stopAgent).toHaveBeenCalledWith('agent-1234');
  });

  it('/status re-sends card and updates cardMessageId', async () => {
    const agent = makeAgent({ id: 'agent-1234', name: 'My Bot' });
    manager.addAgent(agent);
    await svc.handleMessage(makeEvent('/attach My Bot'));
    vi.clearAllMocks();
    vi.spyOn(svc, 'sendCard').mockResolvedValue('msg_new');
    vi.spyOn(svc, 'sendText').mockResolvedValue(undefined);

    await svc.handleMessage(makeEvent('/status'));
    expect(svc.sendCard).toHaveBeenCalled();
    const binding = svc.getBindings().get('chat1');
    expect(binding?.cardMessageId).toBe('msg_new');
  });

  it('free text forwards to agent when bound', async () => {
    manager.addAgent(makeAgent({ id: 'agent-1234', name: 'My Bot' }));
    await svc.handleMessage(makeEvent('/attach My Bot'));
    await svc.handleMessage(makeEvent('hello agent'));
    expect(manager.sendMessage).toHaveBeenCalledWith('agent-1234', 'hello agent');
  });

  it('free text when unbound shows help', async () => {
    await svc.handleMessage(makeEvent('hello'));
    expect(svc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('/attach'));
  });

  it('unknown command sends error', async () => {
    await svc.handleMessage(makeEvent('/unknowncmd'));
    expect(svc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('未知命令'));
  });

  it('non-text message type shows warning', async () => {
    const event = {
      sender: { sender_id: { open_id: 'user1' } },
      message: { chat_id: 'chat1', message_type: 'image', content: '{}' },
    };
    await svc.handleMessage(event);
    expect(svc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('仅支持文本'));
  });

  it('blocks disallowed users', async () => {
    const { svc: restrictedSvc, manager: mgr, tmpDir: td } = makeSvc({
      cfgOverrides: { allowedUsers: ['allowed_user_only'] },
    });
    await restrictedSvc.start();
    vi.spyOn(restrictedSvc, 'sendText').mockResolvedValue(undefined);

    await restrictedSvc.handleMessage(makeEvent('/help', 'chat1', 'different_user'));
    expect(restrictedSvc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('没有权限'));

    restrictedSvc.stop();
    fs.rmSync(td, { recursive: true, force: true });
  });

  it('allows users in allowedUsers list', async () => {
    const { svc: allowedSvc, tmpDir: td } = makeSvc({
      cfgOverrides: { allowedUsers: ['allowed123'] },
    });
    await allowedSvc.start();
    vi.spyOn(allowedSvc, 'sendCard').mockResolvedValue('msg1');

    await allowedSvc.handleMessage(makeEvent('/help', 'chat1', 'allowed123'));
    expect(allowedSvc.sendCard).toHaveBeenCalledWith('chat1', expect.stringContaining('/list'));

    allowedSvc.stop();
    fs.rmSync(td, { recursive: true, force: true });
  });
});

describe('FeishuService - handleCardAction', () => {
  let svc: FeishuService;
  let manager: MockAgentManager;
  let tmpDir: string;

  beforeEach(async () => {
    ({ svc, manager, tmpDir } = makeSvc());
    await svc.start();
    vi.spyOn(svc, 'sendCard').mockResolvedValue('msg_mock');
    vi.spyOn(svc, 'sendText').mockResolvedValue(undefined);
  });

  afterEach(() => {
    svc.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('choice action calls sendInput with the choice', async () => {
    manager.addAgent(makeAgent({ id: 'agent-1234' }));
    const event = {
      operator: { open_id: 'user1' },
      action: { value: { action: 'choice', agent_id: 'agent-1234', choice: 'Yes', chat_id: 'chat1' } },
      context: { open_chat_id: 'chat1' },
    };
    await svc.handleCardAction(event);
    expect(manager.sendMessage).toHaveBeenCalledWith('agent-1234', 'Yes');
    expect(svc.sendText).toHaveBeenCalledWith('chat1', expect.stringContaining('Yes'));
  });

  it('choice action auto-binds chat to agent', async () => {
    manager.addAgent(makeAgent({ id: 'agent-1234' }));
    const event = {
      operator: { open_id: 'user1' },
      action: { value: { action: 'choice', agent_id: 'agent-1234', choice: 'No', chat_id: 'chat2' } },
      context: { open_chat_id: 'chat2' },
    };
    await svc.handleCardAction(event);
    expect(svc.getBindings().get('chat2')?.agentId).toBe('agent-1234');
  });

  it('attach action binds agent and sends card', async () => {
    const agent = makeAgent({ id: 'agent-5678', name: 'Card Agent' });
    manager.addAgent(agent);
    const event = {
      operator: { open_id: 'user1' },
      action: { value: { action: 'attach', agent_id: 'agent-5678', chat_id: 'chat3' } },
      context: { open_chat_id: 'chat3' },
    };
    await svc.handleCardAction(event);
    expect(svc.getBindings().get('chat3')?.agentId).toBe('agent-5678');
    expect(svc.sendCard).toHaveBeenCalled();
  });
});

describe('FeishuService - agent event integration', () => {
  let svc: FeishuService;
  let manager: MockAgentManager;
  let tmpDir: string;

  beforeEach(async () => {
    ({ svc, manager, tmpDir } = makeSvc());
    await svc.start();
    vi.spyOn(svc, 'sendCard').mockResolvedValue('msg_001');
    vi.spyOn(svc, 'patchCard').mockResolvedValue(undefined);
    vi.spyOn(svc, 'sendText').mockResolvedValue(undefined);
  });

  afterEach(() => {
    svc.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('sends card to bound chats on agent:update', async () => {
    vi.useFakeTimers();
    const agent = makeAgent({ id: 'agent-1234' });
    manager.addAgent(agent);

    // Bind chat to agent manually
    svc.getBindings().set('chat_bound', { agentId: 'agent-1234' });

    manager.emit('agent:update', 'agent-1234', agent);

    // Advance debounce timer
    await vi.advanceTimersByTimeAsync(3000);

    expect(svc.sendCard).toHaveBeenCalledWith('chat_bound', expect.any(String));
  });

  it('patches existing card on second agent:update', async () => {
    vi.useFakeTimers();
    const agent = makeAgent({ id: 'agent-1234' });
    manager.addAgent(agent);

    // Binding with existing card message id
    svc.getBindings().set('chat_patched', { agentId: 'agent-1234', cardMessageId: 'existing_msg' });

    manager.emit('agent:update', 'agent-1234', agent);
    await vi.advanceTimersByTimeAsync(3000);

    expect(svc.patchCard).toHaveBeenCalledWith('existing_msg', expect.any(String));
  });

  it('removes binding when agent:status deleted', () => {
    svc.getBindings().set('chat_x', { agentId: 'agent-1234' });
    manager.emit('agent:status', 'agent-1234', 'deleted');
    expect(svc.getBindings().has('chat_x')).toBe(false);
  });

  it('updates pendingChoices on agent:input_required', async () => {
    vi.useFakeTimers();
    const agent = makeAgent({ id: 'agent-1234', status: 'waiting_input' });
    manager.addAgent(agent);
    svc.getBindings().set('chat_choice', { agentId: 'agent-1234' });

    manager.emit('agent:input_required', 'agent-1234', { prompt: 'Choose?', choices: ['A', 'B'] });
    await vi.advanceTimersByTimeAsync(3000);

    const binding = svc.getBindings().get('chat_choice');
    expect(binding?.pendingChoices).toEqual(['A', 'B']);
    expect(svc.sendCard).toHaveBeenCalled();
    // Card should contain choices
    const cardJson = (svc.sendCard as any).mock.calls[0][1];
    expect(cardJson).toContain('"A"');
  });
});

describe('FeishuService - persistence', () => {
  it('persists and reloads bindings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-persist-'));
    const bindingsFile = path.join(tmpDir, 'bindings.json');
    const manager = new MockAgentManager();

    const svc1 = new FeishuService(
      { appId: 'x', appSecret: 'y', bindingsFile },
      manager as any,
    );
    svc1.getBindings().set('chat99', { agentId: 'agent-xyz', cardMessageId: 'msg_persisted' });
    // Force save by calling private method indirectly: use sendText which tries to save
    // Actually trigger by emitting agent:status deleted for a different agent (won't affect chat99)
    manager.emit('agent:status', 'other-agent', 'deleted');

    // Create new instance with same file
    const svc2 = new FeishuService(
      { appId: 'x', appSecret: 'y', bindingsFile },
      manager as any,
    );
    expect(svc2.getBindings().get('chat99')?.agentId).toBe('agent-xyz');
    expect(svc2.getBindings().get('chat99')?.cardMessageId).toBe('msg_persisted');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('FeishuService - lifecycle', () => {
  it('isStarted() reflects state', async () => {
    const { svc, tmpDir } = makeSvc();
    expect(svc.isStarted()).toBe(false);
    await svc.start();
    expect(svc.isStarted()).toBe(true);
    svc.stop();
    expect(svc.isStarted()).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('start() is idempotent', async () => {
    const { svc, tmpDir } = makeSvc();
    await svc.start();
    await svc.start(); // should not throw
    svc.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
