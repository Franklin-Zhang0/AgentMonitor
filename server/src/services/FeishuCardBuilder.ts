import type { Agent, AgentMessage } from '../models/Agent.js';

type CardColor =
  | 'blue' | 'wathet' | 'turquoise' | 'green'
  | 'yellow' | 'orange' | 'red' | 'carmine'
  | 'violet' | 'purple' | 'indigo' | 'grey';

export function statusColor(status: string): CardColor {
  switch (status) {
    case 'running': return 'blue';
    case 'waiting_input': return 'yellow';
    case 'error': return 'red';
    case 'stopped': return 'green';
    default: return 'grey';
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'running': return '运行中';
    case 'waiting_input': return '等待输入';
    case 'error': return '出错';
    case 'stopped': return '已完成';
    default: return status;
  }
}

function formatMessage(msg: AgentMessage): string {
  const MAX = 400;
  let content = msg.content.length > MAX ? msg.content.slice(0, MAX) + '…' : msg.content;
  // escape Lark markdown special chars inside code blocks
  switch (msg.role) {
    case 'user':
      return `**[用户]** ${content}`;
    case 'assistant':
      return content;
    case 'tool':
      return `🔧 \`${msg.toolName || 'tool'}\``;
    case 'system':
      return `*${content}*`;
    default:
      return content;
  }
}

/** Build the main agent status card (Schema 2.0) */
export function buildAgentCard(
  agent: Agent,
  opts?: { chatId?: string; choices?: string[] },
): string {
  const color = statusColor(agent.status);
  const statusText = statusLabel(agent.status);
  const title = `${agent.name}  [${statusText}]`;

  const elements: object[] = [];

  // ── Metadata row ──────────────────────────────────────────
  const meta: string[] = [
    `📁 \`${agent.config.directory}\``,
    `⏰ ${new Date(agent.lastActivity).toLocaleString('zh-CN', { hour12: false })}`,
  ];
  if (agent.costUsd) meta.push(`💰 $${agent.costUsd.toFixed(4)}`);
  if (agent.worktreeBranch) meta.push(`🌿 \`${agent.worktreeBranch}\``);

  elements.push({
    tag: 'markdown',
    content: meta.join('  |  '),
  });

  elements.push({ tag: 'hr' });

  // ── Recent messages ────────────────────────────────────────
  const recentMsgs = agent.messages.slice(-12);
  if (recentMsgs.length > 0) {
    const body = recentMsgs.map(formatMessage).join('\n\n');
    const truncated = body.length > 2800 ? '…' + body.slice(-2800) : body;
    elements.push({ tag: 'markdown', content: truncated });
  } else {
    const preview = agent.config.prompt.slice(0, 200);
    elements.push({
      tag: 'markdown',
      content: `*等待输出…*\n\n**任务：** ${preview}`,
    });
  }

  // ── Choice buttons for waiting_input ───────────────────────
  if (
    agent.status === 'waiting_input' &&
    opts?.choices &&
    opts.choices.length > 0
  ) {
    const buttons = opts.choices.map((choice, i) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: choice },
      type: i === 0 ? 'primary' : 'default',
      value: {
        action: 'choice',
        agent_id: agent.id,
        chat_id: opts.chatId || '',
        choice,
      },
    }));
    elements.push({ tag: 'action', actions: buttons });
  }

  // ── Timestamp note ─────────────────────────────────────────
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      },
    ],
  });

  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: color,
    },
    body: { elements },
  };

  return JSON.stringify(card);
}

/** Build an agent list card */
export function buildAgentListCard(agents: Agent[]): string {
  const elements: object[] = [
    { tag: 'markdown', content: `**🤖 智能体列表（共 ${agents.length} 个）**` },
    { tag: 'hr' },
  ];

  if (agents.length === 0) {
    elements.push({ tag: 'markdown', content: '*暂无智能体*' });
  } else {
    for (const agent of agents) {
      const icon =
        agent.status === 'running' ? '🟠' :
        agent.status === 'waiting_input' ? '🔵' :
        agent.status === 'stopped' ? '🟢' : '🔴';
      const cost = agent.costUsd ? ` · $${agent.costUsd.toFixed(4)}` : '';
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{
              tag: 'markdown',
              content: `${icon} **${agent.name}**\n\`${agent.id.slice(0, 8)}\` · ${statusLabel(agent.status)}${cost}\n${agent.config.directory}`,
            }],
          },
          {
            tag: 'column', width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '连接' },
              type: 'primary',
              value: { action: 'attach', agent_id: agent.id },
            }],
          },
        ],
      });
    }
  }

  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 智能体列表' },
      template: 'blue',
    },
    body: { elements },
  };

  return JSON.stringify(card);
}

/** Build a simple text/info card */
export function buildTextCard(
  text: string,
  title = '提示',
  color: CardColor = 'grey',
): string {
  const card = {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: title },
      template: color,
    },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  };
  return JSON.stringify(card);
}

/** Build the help card */
export function buildHelpCard(): string {
  const content = `**可用命令**

- \`/list\` — 列出所有智能体
- \`/attach <名称或ID>\` — 绑定到指定智能体
- \`/detach\` — 解除绑定
- \`/stop\` — 停止当前绑定的智能体
- \`/status\` — 刷新当前智能体状态卡片
- \`/help\` — 显示此帮助信息

**使用方法**

绑定到智能体后，直接发送文本即可转发给智能体。
当智能体等待输入时，点击选项按钮或直接回复文字即可响应。`;

  return buildTextCard(content, '📖 帮助', 'blue');
}
