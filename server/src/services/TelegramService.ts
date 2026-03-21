import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { Server } from 'socket.io';
import type { Agent, AgentMessage } from '../models/Agent.js';
import type { AgentManager } from './AgentManager.js';

interface BindingInfo {
  agentId: string;
}

export interface TelegramConfig {
  token: string;
  chatId?: string; // restrict to single user
}

interface ExtensionCommand {
  command: string;
  description: string;
}

const TRIVIAL_PATTERNS = [
  /^(let me|now|reading|looking|checking|ok|okay|sure|i'll|i will|searching|opening|running|got it|understood|alright)/i,
  /^.{0,30}$/,  // very short messages
];

function shouldForward(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (const pat of TRIVIAL_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }
  return true;
}

/** Convert simple markdown to Telegram HTML */
function mdToHtml(text: string): string {
  // Code blocks
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.slice(3, -3).replace(/^\w*\n/, '');
    return `<pre>${escapeHtml(inner)}</pre>`;
  });
  // Inline code
  result = result.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  return result;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Split message into chunks of maxLen, trying to break on newlines */
function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let breakPoint = remaining.lastIndexOf('\n', maxLen);
    if (breakPoint < maxLen * 0.3) breakPoint = maxLen;
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).replace(/^\n/, '');
  }
  return chunks;
}

/** Feishu-style Telegram bot service with bidirectional communication */
export class TelegramService extends EventEmitter {
  private cfg: TelegramConfig;
  private manager: AgentManager;
  private bot: any = null;
  private bindings: Map<string, BindingInfo> = new Map(); // chatId -> binding
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingMessages: Map<string, string[]> = new Map(); // agentId -> batched messages
  private bindingsFile: string;
  private io: Server | null = null;
  private started = false;
  private extensionCommands: ExtensionCommand[] = [];

  constructor(cfg: TelegramConfig, manager: AgentManager) {
    super();
    this.cfg = cfg;
    this.manager = manager;
    this.bindingsFile = path.join(process.cwd(), 'data', 'telegram_bindings.json');
    this.loadBindings();
    this.attachManagerListeners();
  }

  setIO(io: Server): void {
    this.io = io;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private loadBindings(): void {
    try {
      if (fs.existsSync(this.bindingsFile)) {
        const raw = fs.readFileSync(this.bindingsFile, 'utf8');
        const data = JSON.parse(raw) as Record<string, BindingInfo>;
        for (const [chatId, info] of Object.entries(data)) {
          this.bindings.set(chatId, info);
        }
      }
    } catch {
      // ignore corrupt file
    }
  }

  private saveBindings(): void {
    try {
      const dir = path.dirname(this.bindingsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, BindingInfo> = {};
      for (const [chatId, info] of this.bindings.entries()) {
        obj[chatId] = info;
      }
      fs.writeFileSync(this.bindingsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error('[Telegram] Failed to save bindings:', err);
    }
  }

  // ── AgentManager event listeners ─────────────────────────────────────────────

  private attachManagerListeners(): void {
    // Real-time output streaming via agent:delta
    this.manager.on('agent:delta', (agentId: string, delta: any) => {
      const messages: AgentMessage[] = delta?.messages || [];
      for (const msg of messages) {
        if (msg.role !== 'assistant' || !msg.content) continue;
        if (!shouldForward(msg.content)) continue;
        this.bufferAssistantMessage(agentId, msg.content);
      }
    });

    // Status change notifications
    this.manager.on('agent:status', (agentId: string, status: string) => {
      if (status === 'deleted') {
        for (const [chatId, info] of this.bindings.entries()) {
          if (info.agentId === agentId) {
            this.bindings.delete(chatId);
            this.sendTg(chatId, `Agent has been deleted. Binding removed.`);
          }
        }
        this.saveBindings();
        return;
      }
      for (const [chatId, info] of this.bindings.entries()) {
        if (info.agentId === agentId) {
          const agent = this.manager.getAgent(agentId);
          const name = agent?.name || agentId.slice(0, 8);
          this.sendTg(chatId, `<b>Status:</b> ${name} is now <b>${status}</b>`, 'HTML');
        }
      }
    });

    // Input required notifications
    this.manager.on('agent:input_required', (agentId: string, data: { prompt: string; choices?: string[] }) => {
      for (const [chatId, info] of this.bindings.entries()) {
        if (info.agentId === agentId) {
          let text = `<b>Input required:</b>\n${escapeHtml(data.prompt)}`;
          if (data.choices && data.choices.length > 0) {
            text += '\n\nChoices:\n' + data.choices.map((c, i) => `  ${i + 1}. ${escapeHtml(c)}`).join('\n');
            text += '\n\nReply with your choice or type a response.';
          }
          this.sendTg(chatId, text, 'HTML');
        }
      }
    });
  }

  /** Buffer assistant messages and flush with debounce */
  private bufferAssistantMessage(agentId: string, content: string): void {
    if (!this.pendingMessages.has(agentId)) {
      this.pendingMessages.set(agentId, []);
    }
    this.pendingMessages.get(agentId)!.push(content);

    const key = `stream:${agentId}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.flushAssistantMessages(agentId);
    }, 2000);
    this.debounceTimers.set(key, timer);
  }

  private flushAssistantMessages(agentId: string): void {
    const msgs = this.pendingMessages.get(agentId);
    if (!msgs || msgs.length === 0) return;
    this.pendingMessages.delete(agentId);

    const combined = msgs.join('\n\n');
    for (const [chatId, info] of this.bindings.entries()) {
      if (info.agentId === agentId) {
        const formatted = mdToHtml(combined);
        const chunks = splitMessage(formatted, 4000);
        for (const chunk of chunks) {
          this.sendTg(chatId, chunk, 'HTML');
        }
      }
    }
  }

  // ── Telegram API wrappers ──────────────────────────────────────────────────

  /** Send a message to a Telegram chat */
  async sendTg(chatId: string, text: string, parseMode?: string): Promise<void> {
    if (!this.bot) return;
    try {
      const chunks = splitMessage(text, 4000);
      for (const chunk of chunks) {
        const opts: any = {};
        if (parseMode) opts.parse_mode = parseMode;
        await this.bot.sendMessage(chatId, chunk, opts);
      }
    } catch (err) {
      console.error('[Telegram] sendMessage error:', err);
    }
  }

  /** Register additional extension commands (for help display) */
  registerExtensionCommands(commands: ExtensionCommand[]): void {
    this.extensionCommands = commands;
  }

  // ── Message handling ─────────────────────────────────────────────────────────

  private isAllowedChat(chatId: string): boolean {
    if (!this.cfg.chatId) return true;
    return String(chatId) === String(this.cfg.chatId);
  }

  private async handleMessage(msg: any): Promise<void> {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();

    if (!this.isAllowedChat(chatId)) return;
    if (!text) return;

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
    } else {
      await this.handleFreeText(chatId, text);
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    // Strip bot username suffix (e.g. /help@MyBot)
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.replace(/@\S+$/, '').toLowerCase();
    const arg = args.join(' ').trim();

    switch (cmd) {
      case '/help':
        await this.showHelp(chatId);
        break;

      case '/list': {
        const agents = this.manager.getAllAgents();
        if (agents.length === 0) {
          await this.sendTg(chatId, 'No agents found.');
          return;
        }
        const lines = agents.map(a => {
          const cost = a.costUsd ? `$${a.costUsd.toFixed(2)}` : '-';
          const task = a.currentTask ? a.currentTask.slice(0, 60) : '-';
          return `<b>${escapeHtml(a.name)}</b> [${a.status}] ${cost}\n  ID: <code>${a.id.slice(0, 8)}</code> | ${escapeHtml(task)}`;
        });
        await this.sendTg(chatId, lines.join('\n\n'), 'HTML');
        break;
      }

      case '/create': {
        if (!arg) {
          await this.sendTg(chatId, 'Usage: /create <directory> <prompt>');
          return;
        }
        const spaceIdx = arg.indexOf(' ');
        if (spaceIdx < 0) {
          await this.sendTg(chatId, 'Usage: /create <directory> <prompt>');
          return;
        }
        const directory = arg.slice(0, spaceIdx);
        const prompt = arg.slice(spaceIdx + 1).trim();
        if (!prompt) {
          await this.sendTg(chatId, 'Usage: /create <directory> <prompt>');
          return;
        }
        try {
          const agent = await this.manager.createAgent(path.basename(directory), {
            provider: 'claude',
            directory,
            prompt,
            flags: {},
          });
          // Auto-bind to the new agent
          this.bindings.set(chatId, { agentId: agent.id });
          this.saveBindings();
          await this.sendTg(
            chatId,
            `<b>Agent created and bound!</b>\nName: ${escapeHtml(agent.name)}\nID: <code>${agent.id.slice(0, 8)}</code>\nDir: <code>${escapeHtml(agent.config.directory)}</code>`,
            'HTML',
          );
        } catch (err) {
          await this.sendTg(chatId, `Failed to create agent: ${String(err)}`);
        }
        break;
      }

      case '/stop': {
        const targetId = arg || this.bindings.get(chatId)?.agentId;
        if (!targetId) {
          await this.sendTg(chatId, 'No agent bound. Use /stop <id> or /attach first.');
          return;
        }
        try {
          await this.manager.stopAgent(targetId);
          await this.sendTg(chatId, 'Stop signal sent.');
        } catch (err) {
          await this.sendTg(chatId, `Stop failed: ${String(err)}`);
        }
        break;
      }

      case '/status': {
        const binding = this.bindings.get(chatId);
        if (!binding) {
          await this.sendTg(chatId, 'No agent bound. Use /attach first.');
          return;
        }
        const agent = this.manager.getAgent(binding.agentId);
        if (!agent) {
          await this.sendTg(chatId, 'Agent not found or deleted.');
          return;
        }
        const cost = agent.costUsd ? `$${agent.costUsd.toFixed(2)}` : '-';
        const tokens = agent.tokenUsage
          ? `In: ${agent.tokenUsage.input.toLocaleString()} / Out: ${agent.tokenUsage.output.toLocaleString()}`
          : '-';
        const task = agent.currentTask || '-';
        const status = [
          `<b>${escapeHtml(agent.name)}</b>`,
          `Status: <b>${agent.status}</b>`,
          `ID: <code>${agent.id}</code>`,
          `Dir: <code>${escapeHtml(agent.config.directory)}</code>`,
          `Cost: ${cost}`,
          `Tokens: ${tokens}`,
          `Task: ${escapeHtml(task)}`,
          `Messages: ${agent.messages.length}`,
          `Created: ${new Date(agent.createdAt).toISOString()}`,
        ].join('\n');
        await this.sendTg(chatId, status, 'HTML');
        break;
      }

      case '/attach':
      case '/use': {
        if (!arg) {
          await this.sendTg(chatId, `Usage: ${cmd} <name or id>`);
          return;
        }
        const agents = this.manager.getAllAgents();
        const target = agents.find(
          a => a.id === arg || a.id.startsWith(arg) || a.name === arg || a.name.includes(arg),
        );
        if (!target) {
          await this.sendTg(chatId, `Agent "${arg}" not found.`);
          return;
        }
        this.bindings.set(chatId, { agentId: target.id });
        this.saveBindings();
        await this.sendTg(
          chatId,
          `Bound to <b>${escapeHtml(target.name)}</b> [${target.status}]\nID: <code>${target.id.slice(0, 8)}</code>`,
          'HTML',
        );
        break;
      }

      case '/detach': {
        if (this.bindings.has(chatId)) {
          this.bindings.delete(chatId);
          this.saveBindings();
          await this.sendTg(chatId, 'Unbound from agent.');
        } else {
          await this.sendTg(chatId, 'No agent is currently bound.');
        }
        break;
      }

      case '/logs': {
        const binding = this.bindings.get(chatId);
        if (!binding) {
          await this.sendTg(chatId, 'No agent bound. Use /attach first.');
          return;
        }
        const agent = this.manager.getAgent(binding.agentId);
        if (!agent) {
          await this.sendTg(chatId, 'Agent not found or deleted.');
          return;
        }
        const n = parseInt(arg, 10) || 5;
        const recent = agent.messages.slice(-n);
        if (recent.length === 0) {
          await this.sendTg(chatId, 'No messages yet.');
          return;
        }
        const lines = recent.map(m => {
          const role = m.role.toUpperCase();
          const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
          return `<b>[${role}]</b>\n${escapeHtml(content)}`;
        });
        const text = lines.join('\n\n');
        const chunks = splitMessage(text, 4000);
        for (const chunk of chunks) {
          await this.sendTg(chatId, chunk, 'HTML');
        }
        break;
      }

      default: {
        // Extension protocol: emit unrecognized commands via Socket.IO
        if (this.io) {
          this.io.emit('telegram:command', {
            chatId,
            command: cmd.replace(/^\//, ''),
            args: arg,
            raw: text,
          });
          // Don't send "unknown command" immediately - give extension a chance
        } else {
          await this.sendTg(chatId, `Unknown command "${cmd}". Send /help for available commands.`);
        }
        break;
      }
    }
  }

  private async showHelp(chatId: string): Promise<void> {
    const lines = [
      '<b>Agent Monitor - Telegram Bot</b>',
      '',
      '/help - Show this help',
      '/list - List all agents',
      '/create &lt;dir&gt; &lt;prompt&gt; - Create a new agent',
      '/stop [id] - Stop bound agent (or specified id)',
      '/status - Show bound agent details',
      '/attach &lt;name|id&gt; - Bind chat to an agent',
      '/use &lt;name|id&gt; - Alias for /attach',
      '/detach - Unbind from agent',
      '/logs [n] - Show last N messages (default 5)',
      '',
      'Send any text to forward it to the bound agent.',
      'If the agent is stopped, it will be resumed with your message.',
    ];
    if (this.extensionCommands.length > 0) {
      lines.push('', '<b>Extension commands:</b>');
      for (const ec of this.extensionCommands) {
        lines.push(`/${ec.command} - ${escapeHtml(ec.description)}`);
      }
    }
    await this.sendTg(chatId, lines.join('\n'), 'HTML');
  }

  private async handleFreeText(chatId: string, text: string): Promise<void> {
    const binding = this.bindings.get(chatId);
    if (!binding) {
      await this.sendTg(chatId, 'No agent bound. Use /attach <name|id> to bind an agent, or /help for commands.');
      return;
    }
    try {
      // sendMessage handles resuming stopped agents automatically
      this.manager.sendMessage(binding.agentId, text);
    } catch (err) {
      await this.sendTg(chatId, `Send failed: ${String(err)}`);
    }
  }

  // ── Startup replay ────────────────────────────────────────────────────────

  private async replayMissedMessages(): Promise<void> {
    const agents = this.manager.getAllAgents();
    for (const [chatId, info] of this.bindings.entries()) {
      const agent = agents.find(a => a.id === info.agentId);
      if (!agent) continue;
      if (agent.status === 'running' || agent.status === 'waiting_input') {
        // Replay last few assistant messages
        const recentAssistant = agent.messages
          .filter(m => m.role === 'assistant')
          .slice(-3);
        if (recentAssistant.length > 0) {
          await this.sendTg(chatId, `<b>Reconnected to ${escapeHtml(agent.name)}</b> [${agent.status}]`, 'HTML');
          for (const msg of recentAssistant) {
            if (shouldForward(msg.content)) {
              const formatted = mdToHtml(msg.content.length > 2000 ? msg.content.slice(-2000) : msg.content);
              await this.sendTg(chatId, formatted, 'HTML');
            }
          }
        }
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const TelegramBot = (await import('node-telegram-bot-api')).default;
    this.bot = new TelegramBot(this.cfg.token, { polling: true });

    this.bot.on('message', (msg: any) => {
      this.handleMessage(msg).catch(err =>
        console.error('[Telegram] handleMessage error:', err),
      );
    });

    console.log('[Telegram] Bot started with polling');
    this.emit('started');

    // Replay missed messages after a short delay
    setTimeout(() => {
      this.replayMissedMessages().catch(err =>
        console.error('[Telegram] replayMissedMessages error:', err),
      );
    }, 3000);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
    }
    console.log('[Telegram] Stopped');
    this.emit('stopped');
  }

  isStarted(): boolean {
    return this.started;
  }

  getBindings(): Map<string, BindingInfo> {
    return this.bindings;
  }
}
