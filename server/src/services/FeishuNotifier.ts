import type { Agent } from '../models/Agent.js';
import { buildAgentCard, buildTextCard } from './FeishuCardBuilder.js';

async function makeClient(appId: string, appSecret: string) {
  const { Client } = await import('@larksuiteoapi/node-sdk');
  return new Client({ appId: appId, appSecret });
}

/**
 * One-way Feishu notifier (REST only, no WebSocket).
 * Mirrors the EmailNotifier / SlackNotifier pattern but sends rich
 * interactive cards so the recipient can respond inline with buttons.
 */
export class FeishuNotifier {
  private appId: string;
  private appSecret: string;
  private clientPromise: Promise<any> | null = null;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  private client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = makeClient(this.appId, this.appSecret);
    }
    return this.clientPromise;
  }

  private async sendCard(chatId: string, cardContent: string): Promise<void> {
    if (!chatId || !this.appId || !this.appSecret) return;
    try {
      const c = await this.client();
      await c.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: cardContent },
      });
    } catch (err) {
      console.error('[FeishuNotifier] sendCard error:', err);
    }
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    if (!chatId || !this.appId || !this.appSecret) return;
    try {
      const c = await this.client();
      await c.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      console.error('[FeishuNotifier] sendText error:', err);
    }
  }

  /**
   * Notify a chat that an agent needs human input.
   * Sends the agent's current status card; if choices are provided,
   * includes clickable buttons so the user can respond inline.
   */
  async notifyHumanNeeded(
    chatId: string,
    agent: Agent,
    choices?: string[],
  ): Promise<void> {
    if (!chatId) return;
    const card = buildAgentCard(agent, { chatId, choices });
    await this.sendCard(chatId, card);
  }

  /**
   * Notify that a pipeline task failed.
   */
  async notifyTaskFailed(chatId: string, taskName: string, error: string): Promise<void> {
    if (!chatId) return;
    const text = `**任务失败：${taskName}**\n\n错误：${error}`;
    await this.sendCard(chatId, buildTextCard(text, '❌ 任务失败', 'red'));
  }

  /**
   * Notify that a stuck agent is waiting for input too long.
   */
  async notifyStuckAgent(
    chatId: string,
    agent: Agent,
    waitingMs: number,
    choices?: string[],
  ): Promise<void> {
    if (!chatId) return;
    const minutes = Math.round(waitingMs / 60000);
    // Send a text header then the interactive agent card with choices
    await this.sendText(chatId, `⚠️ 智能体 "${agent.name}" 已等待 ${minutes} 分钟，请处理。`);
    await this.sendCard(chatId, buildAgentCard(agent, { chatId, choices }));
  }

  /**
   * Notify that the entire pipeline completed.
   */
  async notifyPipelineComplete(
    chatId: string,
    completedCount: number,
    failedCount: number,
  ): Promise<void> {
    if (!chatId) return;
    const status = failedCount > 0 ? 'completed with failures' : 'completed successfully';
    const color = failedCount > 0 ? 'orange' : 'green';
    const text = `流水线 ${status}\n\n✅ 完成：${completedCount} 个任务\n❌ 失败：${failedCount} 个任务`;
    await this.sendCard(chatId, buildTextCard(text, '🏁 流水线完成', color));
  }

  isConfigured(): boolean {
    return !!(this.appId && this.appSecret);
  }
}
