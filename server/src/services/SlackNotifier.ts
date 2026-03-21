import { config } from '../config.js';
import type { AgentManager } from './AgentManager.js';
import type { AgentMessage } from '../models/Agent.js';

const TRIVIAL_PATTERNS = [
  /^(let me|now|reading|looking|checking|ok|okay|sure|i'll|i will|searching|opening|running|got it|understood|alright)/i,
  /^.{0,30}$/,
];

function shouldForward(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (const pat of TRIVIAL_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }
  return true;
}

export class SlackNotifier {
  private defaultWebhookUrl: string;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingMessages: Map<string, string[]> = new Map();

  constructor() {
    this.defaultWebhookUrl = config.slack.webhookUrl;
  }

  /** Start streaming agent output to Slack webhooks */
  startStreaming(manager: AgentManager): void {
    manager.on('agent:delta', (agentId: string, delta: any) => {
      const agent = manager.getAgent(agentId);
      if (!agent) return;
      const webhookUrl = agent.config.slackWebhookUrl;
      if (!webhookUrl) return;

      const messages: AgentMessage[] = delta?.messages || [];
      for (const msg of messages) {
        if (msg.role !== 'assistant' || !msg.content) continue;
        if (!shouldForward(msg.content)) continue;
        this.bufferMessage(agentId, webhookUrl, msg.content);
      }
    });
  }

  private bufferMessage(agentId: string, webhookUrl: string, content: string): void {
    const key = `stream:${agentId}`;
    if (!this.pendingMessages.has(key)) {
      this.pendingMessages.set(key, []);
    }
    this.pendingMessages.get(key)!.push(content);

    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.flushMessages(key, agentId, webhookUrl);
    }, 5000);
    this.debounceTimers.set(key, timer);
  }

  private flushMessages(key: string, agentId: string, webhookUrl: string): void {
    const msgs = this.pendingMessages.get(key);
    if (!msgs || msgs.length === 0) return;
    this.pendingMessages.delete(key);

    const combined = msgs.join('\n\n');
    const text = combined.length > 3000 ? combined.slice(0, 3000) + '\n...(truncated)' : combined;
    this.sendNotification(`[${agentId.slice(0, 8)}] ${text}`, webhookUrl).catch(err =>
      console.error('[SlackNotifier] streaming error:', err),
    );
  }

  async sendNotification(
    body: string,
    webhookUrl?: string,
  ): Promise<boolean> {
    const url = webhookUrl || this.defaultWebhookUrl;
    if (!url) {
      console.log(`[SlackNotifier] No Slack webhook configured. Would send: ${body}`);
      return false;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: body }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[SlackNotifier] Slack webhook error:', response.status, errorBody);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[SlackNotifier] Failed to send Slack message:', err);
      return false;
    }
  }

  async notifyHumanNeeded(
    agentName: string,
    message: string,
    webhookUrl?: string,
  ): Promise<boolean> {
    return this.sendNotification(
      `[Agent Monitor] *${agentName}* needs your attention:\n\n${message}`,
      webhookUrl,
    );
  }
}
