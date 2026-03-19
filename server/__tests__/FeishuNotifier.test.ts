import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK
vi.mock('@larksuiteoapi/node-sdk', () => {
  const createMock = vi.fn().mockResolvedValue({ data: { message_id: 'msg_1' } });
  const Client = class {
    im = { v1: { message: { create: createMock } } };
    static _createMock = createMock;
  };
  return { Client };
});

import { FeishuNotifier } from '../src/services/FeishuNotifier.js';
import type { Agent } from '../src/models/Agent.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-abc',
    name: 'Test Agent',
    status: 'waiting_input',
    config: { provider: 'claude', directory: '/tmp', prompt: 'do it', flags: {} },
    messages: [],
    lastActivity: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('FeishuNotifier', () => {
  it('isConfigured() returns false when no credentials', () => {
    expect(new FeishuNotifier('', '').isConfigured()).toBe(false);
  });

  it('isConfigured() returns true when credentials set', () => {
    expect(new FeishuNotifier('app123', 'secret456').isConfigured()).toBe(true);
  });

  it('notifyHumanNeeded does nothing when chatId is empty', async () => {
    const notifier = new FeishuNotifier('app', 'secret');
    // Should not throw
    await expect(notifier.notifyHumanNeeded('', makeAgent())).resolves.toBeUndefined();
  });

  it('notifyHumanNeeded sends a card with choices when chatId provided', async () => {
    const notifier = new FeishuNotifier('app', 'secret');
    const sendCardSpy = vi.spyOn(notifier as any, 'sendCard').mockResolvedValue(undefined);
    const agent = makeAgent({ status: 'waiting_input' });

    await notifier.notifyHumanNeeded('chat1', agent, ['Yes', 'No']);

    expect(sendCardSpy).toHaveBeenCalledWith('chat1', expect.stringContaining('Yes'));
    // Card should have choice buttons
    const card = JSON.parse(sendCardSpy.mock.calls[0][1]);
    const actions = card.body.elements.find((e: any) => e.tag === 'action');
    expect(actions?.actions).toHaveLength(2);
  });

  it('notifyTaskFailed sends a red card', async () => {
    const notifier = new FeishuNotifier('app', 'secret');
    const sendCardSpy = vi.spyOn(notifier as any, 'sendCard').mockResolvedValue(undefined);

    await notifier.notifyTaskFailed('chat1', 'Build Step', 'Out of memory');

    expect(sendCardSpy).toHaveBeenCalledWith('chat1', expect.any(String));
    const card = JSON.parse(sendCardSpy.mock.calls[0][1]);
    expect(card.header.template).toBe('red');
    expect(JSON.stringify(card)).toContain('Build Step');
    expect(JSON.stringify(card)).toContain('Out of memory');
  });

  it('notifyStuckAgent sends text + agent card', async () => {
    const notifier = new FeishuNotifier('app', 'secret');
    const sendTextSpy = vi.spyOn(notifier as any, 'sendText').mockResolvedValue(undefined);
    const sendCardSpy = vi.spyOn(notifier as any, 'sendCard').mockResolvedValue(undefined);
    const agent = makeAgent({ status: 'waiting_input' });

    await notifier.notifyStuckAgent('chat1', agent, 6 * 60 * 1000);

    expect(sendTextSpy).toHaveBeenCalledWith('chat1', expect.stringContaining('6 分钟'));
    expect(sendCardSpy).toHaveBeenCalledWith('chat1', expect.any(String));
  });

  it('notifyPipelineComplete sends green card on success', async () => {
    const notifier = new FeishuNotifier('app', 'secret');
    const sendCardSpy = vi.spyOn(notifier as any, 'sendCard').mockResolvedValue(undefined);

    await notifier.notifyPipelineComplete('chat1', 5, 0);

    const card = JSON.parse(sendCardSpy.mock.calls[0][1]);
    expect(card.header.template).toBe('green');
    expect(JSON.stringify(card)).toContain('5');
  });

  it('notifyPipelineComplete sends orange card on partial failure', async () => {
    const notifier = new FeishuNotifier('app', 'secret');
    const sendCardSpy = vi.spyOn(notifier as any, 'sendCard').mockResolvedValue(undefined);

    await notifier.notifyPipelineComplete('chat1', 3, 2);

    const card = JSON.parse(sendCardSpy.mock.calls[0][1]);
    expect(card.header.template).toBe('orange');
  });

  it('all methods are no-ops when credentials are empty', async () => {
    const notifier = new FeishuNotifier('', '');
    const agent = makeAgent();
    // None of these should throw or make network calls
    await expect(notifier.notifyHumanNeeded('chat1', agent)).resolves.toBeUndefined();
    await expect(notifier.notifyTaskFailed('chat1', 'task', 'err')).resolves.toBeUndefined();
    await expect(notifier.notifyStuckAgent('chat1', agent, 1000)).resolves.toBeUndefined();
    await expect(notifier.notifyPipelineComplete('chat1', 1, 0)).resolves.toBeUndefined();
  });
});
