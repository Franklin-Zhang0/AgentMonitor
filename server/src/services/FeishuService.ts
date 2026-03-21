import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { Agent, AgentMessage } from '../models/Agent.js';
import type { AgentManager } from './AgentManager.js';
import {
  buildAgentCard,
  buildAgentListCard,
  buildTextCard,
  buildHelpCard,
} from './FeishuCardBuilder.js';

// Lazy SDK import to allow tests to mock it
async function loadSdk() {
  const sdk = await import('@larksuiteoapi/node-sdk');
  return sdk;
}

interface BindingInfo {
  agentId: string;
  cardMessageId?: string;    // message_id of the card we sent (for patching)
  pendingChoices?: string[]; // current waiting_input choices
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** Open IDs of users allowed to operate the bot (empty = allow all) */
  allowedUsers?: string[];
  /** Path to persist bindings JSON */
  bindingsFile?: string;
}

/** Feishu (Lark) interactive bot service */
export class FeishuService extends EventEmitter {
  private cfg: FeishuConfig;
  private manager: AgentManager;
  private bindings: Map<string, BindingInfo> = new Map(); // chatId → binding
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private bindingsFile: string;
  private client: any = null;
  private wsClient: any = null;
  private started = false;

  constructor(cfg: FeishuConfig, manager: AgentManager) {
    super();
    this.cfg = cfg;
    this.manager = manager;
    this.bindingsFile = cfg.bindingsFile || path.join(process.cwd(), 'data', 'feishu_bindings.json');
    this.loadBindings();
    this.attachManagerListeners();
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
      console.error('[Feishu] Failed to save bindings:', err);
    }
  }

  // ── AgentManager event listeners ─────────────────────────────────────────────

  private attachManagerListeners(): void {
    this.manager.on('agent:update', (agentId: string, agent: Agent) => {
      this.scheduleCardUpdate(agentId, agent);
    });

    this.manager.on('agent:status', (agentId: string, status: string) => {
      if (status === 'deleted') {
        // Remove bindings pointing to deleted agent
        for (const [chatId, info] of this.bindings.entries()) {
          if (info.agentId === agentId) {
            this.bindings.delete(chatId);
          }
        }
        this.saveBindings();
        return;
      }
      const agent = this.manager.getAgent(agentId);
      if (agent) this.scheduleCardUpdate(agentId, agent);
    });

    // Real-time output streaming: forward assistant messages as text
    this.manager.on('agent:delta', (agentId: string, delta: any) => {
      const messages: AgentMessage[] = delta?.messages || [];
      for (const msg of messages) {
        if (msg.role !== 'assistant' || !msg.content) continue;
        if (!this.shouldForwardMessage(msg.content)) continue;
        this.scheduleTextForward(agentId, msg.content);
      }
    });

    this.manager.on('agent:input_required', (agentId: string, data: { prompt: string; choices?: string[] }) => {
      // Update pending choices in bindings
      for (const [chatId, info] of this.bindings.entries()) {
        if (info.agentId === agentId) {
          info.pendingChoices = data.choices || [];
          this.saveBindings();
          const agent = this.manager.getAgent(agentId);
          if (agent) this.scheduleCardUpdate(agentId, agent);
        }
      }
    });
  }

  private static readonly TRIVIAL_PATTERNS = [
    /^(let me|now|reading|looking|checking|ok|okay|sure|i'll|i will|searching|opening|running|got it|understood|alright)/i,
    /^.{0,30}$/,
  ];

  private shouldForwardMessage(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    for (const pat of FeishuService.TRIVIAL_PATTERNS) {
      if (pat.test(trimmed)) return false;
    }
    return true;
  }

  private pendingTextMessages: Map<string, string[]> = new Map();

  /** Schedule debounced text forwarding for assistant messages */
  private scheduleTextForward(agentId: string, content: string): void {
    if (!this.pendingTextMessages.has(agentId)) {
      this.pendingTextMessages.set(agentId, []);
    }
    this.pendingTextMessages.get(agentId)!.push(content);

    const key = `text:${agentId}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.flushTextForward(agentId);
    }, 2000);
    this.debounceTimers.set(key, timer);
  }

  private flushTextForward(agentId: string): void {
    const msgs = this.pendingTextMessages.get(agentId);
    if (!msgs || msgs.length === 0) return;
    this.pendingTextMessages.delete(agentId);

    const combined = msgs.join('\n\n');
    // Truncate to ~4000 chars for Feishu
    const text = combined.length > 4000 ? combined.slice(0, 4000) + '\n...(truncated)' : combined;

    for (const [chatId, info] of this.bindings.entries()) {
      if (info.agentId === agentId) {
        this.sendText(chatId, text).catch(err =>
          console.error('[Feishu] flushTextForward error:', err),
        );
      }
    }
  }

  /** Schedule a debounced card update (2s) to avoid rate limits */
  private scheduleCardUpdate(agentId: string, agent: Agent): void {
    const key = agentId;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.pushCardForAgent(agentId, agent).catch(err =>
        console.error('[Feishu] pushCardForAgent error:', err),
      );
    }, 2000);
    this.debounceTimers.set(key, timer);
  }

  /** Find all chats bound to this agent and update/send their cards */
  private async pushCardForAgent(agentId: string, agent: Agent): Promise<void> {
    for (const [chatId, info] of this.bindings.entries()) {
      if (info.agentId !== agentId) continue;

      const cardContent = buildAgentCard(agent, {
        chatId,
        choices: info.pendingChoices,
      });

      if (info.cardMessageId) {
        await this.patchCard(info.cardMessageId, cardContent);
      } else {
        const msgId = await this.sendCard(chatId, cardContent);
        if (msgId) {
          info.cardMessageId = msgId;
          this.saveBindings();
        }
      }
    }
  }

  // ── Feishu SDK wrappers ──────────────────────────────────────────────────────

  /** Send an interactive card to a chat; returns message_id */
  async sendCard(chatId: string, cardContent: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });
      return resp?.data?.message_id ?? null;
    } catch (err) {
      console.error('[Feishu] sendCard error:', err);
      return null;
    }
  }

  /** Patch (update in-place) an existing card message */
  async patchCard(messageId: string, cardContent: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardContent },
      });
    } catch (err) {
      console.error('[Feishu] patchCard error:', err);
    }
  }

  /** Send a plain text message to a chat */
  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      console.error('[Feishu] sendText error:', err);
    }
  }

  // ── Message handling ─────────────────────────────────────────────────────────

  private isAllowedUser(openId: string): boolean {
    const allowed = this.cfg.allowedUsers;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(openId);
  }

  async handleMessage(event: any): Promise<void> {
    const senderOpenId: string = event?.sender?.sender_id?.open_id ?? '';
    const message = event?.message;
    if (!message) return;

    const chatId: string = message.chat_id ?? '';
    const msgType: string = message.message_type ?? '';

    if (!chatId) return;
    if (!this.isAllowedUser(senderOpenId)) {
      await this.sendText(chatId, '⛔ 您没有权限使用此机器人。');
      return;
    }

    // Only handle text messages
    if (msgType !== 'text') {
      await this.sendText(chatId, '⚠️ 仅支持文本消息。');
      return;
    }

    let text = '';
    try {
      text = JSON.parse(message.content)?.text ?? '';
    } catch {
      return;
    }
    text = text.trim();

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
    } else {
      await this.handleFreeText(chatId, text);
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    const [cmd, ...args] = text.split(/\s+/);
    const arg = args.join(' ').trim();

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sendCard(chatId, buildHelpCard());
        break;

      case '/list': {
        const agents = this.manager.getAllAgents();
        await this.sendCard(chatId, buildAgentListCard(agents));
        break;
      }

      case '/attach': {
        if (!arg) {
          await this.sendText(chatId, '用法: /attach <名称或ID>');
          return;
        }
        const agents = this.manager.getAllAgents();
        const target = agents.find(
          a => a.id === arg || a.id.startsWith(arg) || a.name === arg || a.name.includes(arg),
        );
        if (!target) {
          await this.sendCard(chatId, buildTextCard(`找不到智能体 "${arg}"`, '错误', 'red'));
          return;
        }
        const info: BindingInfo = { agentId: target.id };
        this.bindings.set(chatId, info);
        this.saveBindings();

        const cardContent = buildAgentCard(target, { chatId });
        const msgId = await this.sendCard(chatId, cardContent);
        if (msgId) {
          info.cardMessageId = msgId;
          this.saveBindings();
        }
        break;
      }

      case '/detach': {
        if (this.bindings.has(chatId)) {
          this.bindings.delete(chatId);
          this.saveBindings();
          await this.sendText(chatId, '✅ 已解除绑定。');
        } else {
          await this.sendText(chatId, '当前没有绑定任何智能体。');
        }
        break;
      }

      case '/create': {
        if (!arg) {
          await this.sendText(chatId, '用法: /create <目录> <提示词>');
          return;
        }
        const spaceIdx = arg.indexOf(' ');
        if (spaceIdx < 0) {
          await this.sendText(chatId, '用法: /create <目录> <提示词>');
          return;
        }
        const directory = arg.slice(0, spaceIdx);
        const prompt = arg.slice(spaceIdx + 1).trim();
        if (!prompt) {
          await this.sendText(chatId, '用法: /create <目录> <提示词>');
          return;
        }
        try {
          const newAgent = await this.manager.createAgent(path.basename(directory), {
            provider: 'claude',
            directory,
            prompt,
            flags: {},
          });
          // Auto-bind
          const newInfo: BindingInfo = { agentId: newAgent.id };
          this.bindings.set(chatId, newInfo);
          this.saveBindings();
          const cardContent = buildAgentCard(newAgent, { chatId });
          const msgId = await this.sendCard(chatId, cardContent);
          if (msgId) {
            newInfo.cardMessageId = msgId;
            this.saveBindings();
          }
        } catch (err) {
          await this.sendCard(chatId, buildTextCard(`创建失败: ${String(err)}`, '错误', 'red'));
        }
        break;
      }

      case '/stop': {
        const binding = this.bindings.get(chatId);
        if (!binding) {
          await this.sendText(chatId, '当前没有绑定任何智能体。');
          return;
        }
        try {
          await this.manager.stopAgent(binding.agentId);
          await this.sendText(chatId, '✅ 已发送停止信号。');
        } catch (err) {
          await this.sendText(chatId, `停止失败: ${String(err)}`);
        }
        break;
      }

      case '/status': {
        const binding = this.bindings.get(chatId);
        if (!binding) {
          await this.sendText(chatId, '当前没有绑定任何智能体。');
          return;
        }
        const agent = this.manager.getAgent(binding.agentId);
        if (!agent) {
          await this.sendText(chatId, '智能体不存在或已被删除。');
          return;
        }
        const cardContent = buildAgentCard(agent, { chatId, choices: binding.pendingChoices });
        const msgId = await this.sendCard(chatId, cardContent);
        if (msgId) {
          binding.cardMessageId = msgId;
          this.saveBindings();
        }
        break;
      }

      default:
        await this.sendText(chatId, `未知命令 "${cmd}"。发送 /help 查看帮助。`);
    }
  }

  private async handleFreeText(chatId: string, text: string): Promise<void> {
    const binding = this.bindings.get(chatId);
    if (!binding) {
      await this.sendText(chatId, '当前没有绑定任何智能体。请先使用 /attach <名称或ID> 绑定智能体，或 /help 查看帮助。');
      return;
    }
    try {
      await this.manager.sendMessage(binding.agentId, text);
      // Clear pending choices once user replied
      binding.pendingChoices = undefined;
      this.saveBindings();
    } catch (err) {
      await this.sendText(chatId, `发送失败: ${String(err)}`);
    }
  }

  async handleCardAction(event: any): Promise<void> {
    const openId: string = event?.operator?.open_id ?? '';
    const value: Record<string, string> = event?.action?.value ?? {};
    const chatId: string = value.chat_id || event?.context?.open_chat_id || '';

    if (!chatId) return;
    if (!this.isAllowedUser(openId)) return;

    const action = value.action;
    const agentId = value.agent_id;

    if (action === 'choice' && agentId) {
      const choice = value.choice;
      const binding = this.bindings.get(chatId);
      if (binding?.agentId !== agentId) {
        // Auto-bind to this agent
        this.bindings.set(chatId, { agentId });
        this.saveBindings();
      }
      try {
        await this.manager.sendMessage(agentId, choice);
        const b = this.bindings.get(chatId);
        if (b) {
          b.pendingChoices = undefined;
          this.saveBindings();
        }
        await this.sendText(chatId, `✅ 已回复: ${choice}`);
      } catch (err) {
        await this.sendText(chatId, `发送失败: ${String(err)}`);
      }
      return;
    }

    if (action === 'attach' && agentId) {
      const agent = this.manager.getAgent(agentId);
      if (!agent) {
        await this.sendText(chatId, '智能体不存在或已被删除。');
        return;
      }
      const info: BindingInfo = { agentId };
      this.bindings.set(chatId, info);
      this.saveBindings();

      const cardContent = buildAgentCard(agent, { chatId });
      const msgId = await this.sendCard(chatId, cardContent);
      if (msgId) {
        info.cardMessageId = msgId;
        this.saveBindings();
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const sdk = await loadSdk();
    const { Client, WSClient, EventDispatcher } = sdk;

    this.client = new Client({
      appID: this.cfg.appId,
      appSecret: this.cfg.appSecret,
    });

    this.wsClient = new WSClient({
      appID: this.cfg.appId,
      appSecret: this.cfg.appSecret,
    });

    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
      'card.action.trigger': async (data: any) => {
        await this.handleCardAction(data);
        return {}; // card action must return an object
      },
    } as any);

    await this.wsClient.start({ eventDispatcher });
    console.log('[Feishu] WebSocket connection started');
    this.emit('started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    // WSClient doesn't expose a stop method in all versions; best effort
    if (this.wsClient && typeof this.wsClient.stop === 'function') {
      this.wsClient.stop();
    }
    console.log('[Feishu] Stopped');
    this.emit('stopped');
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Expose bindings map for testing */
  getBindings(): Map<string, BindingInfo> {
    return this.bindings;
  }
}
