import { describe, it, expect } from 'vitest';
import {
  statusColor,
  statusLabel,
  buildAgentCard,
  buildAgentListCard,
  buildTextCard,
  buildHelpCard,
} from '../src/services/FeishuCardBuilder.js';
import type { Agent } from '../src/models/Agent.js';

const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'test-agent-id-1234',
  name: 'Test Agent',
  status: 'running',
  config: {
    provider: 'claude',
    directory: '/tmp/test',
    prompt: 'Do something',
    flags: {},
  },
  messages: [],
  lastActivity: Date.now(),
  createdAt: Date.now(),
  ...overrides,
});

describe('statusColor', () => {
  it('maps running → blue', () => expect(statusColor('running')).toBe('blue'));
  it('maps waiting_input → yellow', () => expect(statusColor('waiting_input')).toBe('yellow'));
  it('maps error → red', () => expect(statusColor('error')).toBe('red'));
  it('maps stopped → green', () => expect(statusColor('stopped')).toBe('green'));
  it('maps unknown → grey', () => expect(statusColor('unknown')).toBe('grey'));
});

describe('statusLabel', () => {
  it('maps running', () => expect(statusLabel('running')).toBe('运行中'));
  it('maps waiting_input', () => expect(statusLabel('waiting_input')).toBe('等待输入'));
  it('maps error', () => expect(statusLabel('error')).toBe('出错'));
  it('maps stopped', () => expect(statusLabel('stopped')).toBe('已完成'));
  it('returns raw for unknown', () => expect(statusLabel('foo')).toBe('foo'));
});

describe('buildAgentCard', () => {
  it('returns valid JSON string', () => {
    const agent = makeAgent();
    const json = buildAgentCard(agent);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('card has schema 2.0', () => {
    const card = JSON.parse(buildAgentCard(makeAgent()));
    expect(card.schema).toBe('2.0');
  });

  it('header title contains agent name and status', () => {
    const agent = makeAgent({ status: 'running' });
    const card = JSON.parse(buildAgentCard(agent));
    expect(card.header.title.content).toContain('Test Agent');
    expect(card.header.title.content).toContain('运行中');
  });

  it('header template color matches status', () => {
    const card = JSON.parse(buildAgentCard(makeAgent({ status: 'error' })));
    expect(card.header.template).toBe('red');
  });

  it('shows choice buttons when waiting_input and choices provided', () => {
    const agent = makeAgent({ status: 'waiting_input' });
    const card = JSON.parse(
      buildAgentCard(agent, { choices: ['Yes', 'No'], chatId: 'chat1' }),
    );
    const actions = card.body.elements.find((e: any) => e.tag === 'action');
    expect(actions).toBeDefined();
    expect(actions.actions).toHaveLength(2);
    expect(actions.actions[0].text.content).toBe('Yes');
    expect(actions.actions[0].value.choice).toBe('Yes');
    expect(actions.actions[0].value.chat_id).toBe('chat1');
    expect(actions.actions[0].value.action).toBe('choice');
  });

  it('does not show choice buttons when not waiting_input', () => {
    const agent = makeAgent({ status: 'running' });
    const card = JSON.parse(
      buildAgentCard(agent, { choices: ['Yes', 'No'] }),
    );
    const actions = card.body.elements.find((e: any) => e.tag === 'action');
    expect(actions).toBeUndefined();
  });

  it('includes directory metadata', () => {
    const agent = makeAgent();
    const card = JSON.parse(buildAgentCard(agent));
    const markdown = card.body.elements.find((e: any) => e.tag === 'markdown');
    expect(markdown.content).toContain('/tmp/test');
  });

  it('shows messages when present', () => {
    const agent = makeAgent({
      messages: [
        { id: '1', role: 'user', content: 'Hello', timestamp: Date.now() },
        { id: '2', role: 'assistant', content: 'Hi there', timestamp: Date.now() },
      ],
    });
    const card = JSON.parse(buildAgentCard(agent));
    const markdowns = card.body.elements.filter((e: any) => e.tag === 'markdown');
    const msgContent = markdowns.map((m: any) => m.content).join('\n');
    expect(msgContent).toContain('Hello');
    expect(msgContent).toContain('Hi there');
  });

  it('shows cost when present', () => {
    const agent = makeAgent({ costUsd: 0.0123 });
    const card = JSON.parse(buildAgentCard(agent));
    const meta = card.body.elements[0].content;
    expect(meta).toContain('$0.0123');
  });

  it('shows worktree branch when present', () => {
    const agent = makeAgent({ worktreeBranch: 'agent-abcd1234' });
    const card = JSON.parse(buildAgentCard(agent));
    const meta = card.body.elements[0].content;
    expect(meta).toContain('agent-abcd1234');
  });

  it('truncates long messages', () => {
    const longContent = 'A'.repeat(500);
    const agent = makeAgent({
      messages: [{ id: '1', role: 'assistant', content: longContent, timestamp: Date.now() }],
    });
    const card = JSON.parse(buildAgentCard(agent));
    const markdowns = card.body.elements.filter((e: any) => e.tag === 'markdown');
    const msgContent = markdowns.map((m: any) => m.content).join('\n');
    expect(msgContent.length).toBeLessThan(longContent.length + 100);
  });
});

describe('buildAgentListCard', () => {
  it('returns valid JSON string', () => {
    expect(() => JSON.parse(buildAgentListCard([]))).not.toThrow();
  });

  it('shows empty state when no agents', () => {
    const card = JSON.parse(buildAgentListCard([]));
    const content = JSON.stringify(card);
    expect(content).toContain('暂无智能体');
  });

  it('shows each agent name', () => {
    const agents = [
      makeAgent({ id: 'id1', name: 'Agent One' }),
      makeAgent({ id: 'id2', name: 'Agent Two', status: 'stopped' }),
    ];
    const card = JSON.parse(buildAgentListCard(agents));
    const content = JSON.stringify(card);
    expect(content).toContain('Agent One');
    expect(content).toContain('Agent Two');
  });

  it('includes attach button with agent_id', () => {
    const agents = [makeAgent({ id: 'agent-abc-123', name: 'My Agent' })];
    const card = JSON.parse(buildAgentListCard(agents));
    const content = JSON.stringify(card);
    expect(content).toContain('agent-abc-123');
    expect(content).toContain('attach');
  });
});

describe('buildTextCard', () => {
  it('returns valid JSON', () => {
    expect(() => JSON.parse(buildTextCard('hello'))).not.toThrow();
  });

  it('includes the text in the card body', () => {
    const card = JSON.parse(buildTextCard('Test message', 'My Title', 'blue'));
    const content = JSON.stringify(card);
    expect(content).toContain('Test message');
    expect(content).toContain('My Title');
  });

  it('uses default title and grey color', () => {
    const card = JSON.parse(buildTextCard('hi'));
    expect(card.header.template).toBe('grey');
    expect(card.header.title.content).toBe('提示');
  });
});

describe('buildHelpCard', () => {
  it('returns valid JSON', () => {
    expect(() => JSON.parse(buildHelpCard())).not.toThrow();
  });

  it('contains all commands', () => {
    const card = JSON.parse(buildHelpCard());
    const content = JSON.stringify(card);
    expect(content).toContain('/list');
    expect(content).toContain('/attach');
    expect(content).toContain('/detach');
    expect(content).toContain('/stop');
    expect(content).toContain('/status');
    expect(content).toContain('/help');
  });
});
