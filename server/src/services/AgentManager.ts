import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { basename } from 'path';
import type { Agent, AgentConfig, AgentMessage, AgentStatus } from '../models/Agent.js';
import { AgentStore } from '../store/AgentStore.js';
import { AgentProcess, type StreamMessage } from './AgentProcess.js';
import { WorktreeManager } from './WorktreeManager.js';
import { EmailNotifier } from './EmailNotifier.js';
import { WhatsAppNotifier } from './WhatsAppNotifier.js';
import { SlackNotifier } from './SlackNotifier.js';

export class AgentManager extends EventEmitter {
  private processes: Map<string, AgentProcess> = new Map();
  private store: AgentStore;
  private worktreeManager: WorktreeManager;
  private emailNotifier: EmailNotifier;
  private whatsappNotifier: WhatsAppNotifier;
  private slackNotifier: SlackNotifier;

  constructor(store: AgentStore, worktreeManager?: WorktreeManager, emailNotifier?: EmailNotifier, whatsappNotifier?: WhatsAppNotifier, slackNotifier?: SlackNotifier) {
    super();
    this.store = store;
    this.worktreeManager = worktreeManager || new WorktreeManager();
    this.emailNotifier = emailNotifier || new EmailNotifier();
    this.whatsappNotifier = whatsappNotifier || new WhatsAppNotifier();
    this.slackNotifier = slackNotifier || new SlackNotifier();
  }

  async createAgent(name: string, agentConfig: AgentConfig): Promise<Agent> {
    const id = uuid();
    const branchName = `agent-${id.slice(0, 8)}`;

    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    // Create git worktree for isolation
    try {
      const result = this.worktreeManager.createWorktree(
        agentConfig.directory,
        branchName,
        agentConfig.claudeMd,
      );
      worktreePath = result.worktreePath;
      worktreeBranch = result.branch;
    } catch (err) {
      // If worktree creation fails, work directly in the directory
      console.warn('[AgentManager] Worktree creation failed, using directory directly:', err);
      worktreePath = agentConfig.directory;
    }

    const agent: Agent = {
      id,
      name,
      status: 'running',
      config: agentConfig,
      worktreePath,
      worktreeBranch,
      messages: [],
      lastActivity: Date.now(),
      createdAt: Date.now(),
      projectName: basename(agentConfig.directory),
      mcpServers: this.parseMcpServers(agentConfig.flags.mcpConfig),
      currentTask: agentConfig.prompt.length > 120 ? agentConfig.prompt.slice(0, 120) + '...' : agentConfig.prompt,
    };

    this.store.saveAgent(agent);
    this.startProcess(agent);

    return agent;
  }

  private startProcess(agent: Agent): void {
    const proc = new AgentProcess();
    this.processes.set(agent.id, proc);

    proc.on('message', (msg: StreamMessage) => {
      this.handleStreamMessage(agent.id, msg, agent.config.provider);
    });

    proc.on('stderr', (text: string) => {
      console.error(`[Agent ${agent.id}] stderr: ${text}`);
      // Store stderr in messages for debugging
      const a = this.store.getAgent(agent.id);
      if (a) {
        a.messages.push({
          id: uuid(),
          role: 'system',
          content: `[stderr] ${text}`,
          timestamp: Date.now(),
        });
        a.lastActivity = Date.now();
        this.store.saveAgent(a);
      }
    });

    proc.on('exit', (code: number | null) => {
      // Don't override 'stopped' status (set when result message is received)
      const current = this.store.getAgent(agent.id);
      if (current && current.status !== 'stopped') {
        // null exit code (from SIGTERM/SIGKILL) after result is fine; only real errors are non-zero
        const status = (code === 0 || code === null) ? 'stopped' : 'error';
        this.updateAgentStatus(agent.id, status);
      }
      this.processes.delete(agent.id);
    });

    proc.on('error', (err: Error) => {
      console.error(`[Agent ${agent.id}] process error:`, err);
      this.updateAgentStatus(agent.id, 'error');
    });

    proc.start({
      provider: agent.config.provider,
      directory: agent.worktreePath || agent.config.directory,
      prompt: agent.config.prompt,
      dangerouslySkipPermissions: agent.config.flags.dangerouslySkipPermissions,
      resume: agent.config.flags.resume,
      model: agent.config.flags.model,
      fullAuto: agent.config.flags.fullAuto,
      chrome: agent.config.flags.chrome,
      permissionMode: agent.config.flags.permissionMode,
      maxBudgetUsd: agent.config.flags.maxBudgetUsd,
      allowedTools: agent.config.flags.allowedTools,
      disallowedTools: agent.config.flags.disallowedTools,
      addDirs: agent.config.flags.addDirs,
      mcpConfig: agent.config.flags.mcpConfig,
    });

    agent.pid = proc.pid;
    this.store.saveAgent(agent);
  }

  private handleStreamMessage(agentId: string, msg: StreamMessage, provider: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;

    const prevMsgCount = agent.messages.length;

    if (provider === 'codex') {
      this.handleCodexMessage(agent, msg);
    } else {
      this.handleClaudeMessage(agent, msg);
    }

    // Emit raw message (kept for backward compat)
    this.emit('agent:message', agentId, msg);

    // Emit lightweight delta with only new messages + metadata (efficient for tunnel)
    const newMessages = agent.messages.slice(prevMsgCount);
    if (newMessages.length > 0) {
      this.emit('agent:delta', agentId, {
        messages: newMessages,
        status: agent.status,
        costUsd: agent.costUsd,
        tokenUsage: agent.tokenUsage,
        lastActivity: agent.lastActivity,
      });
    }

    // Full snapshot for dashboard cards (less frequent)
    const updated = this.store.getAgent(agentId);
    if (updated) {
      this.emit('agent:update', agentId, updated);
    }
  }

  private handleClaudeMessage(agent: Agent, msg: StreamMessage): void {
    // With --verbose, assistant messages have: {type: "assistant", message: {content: [{type: "text", text: "..."}]}}
    if (msg.type === 'assistant') {
      const message = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            agent.messages.push({
              id: uuid(),
              role: 'assistant',
              content: block.text,
              timestamp: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            agent.messages.push({
              id: uuid(),
              role: 'tool',
              content: `Using tool: ${block.name || 'unknown'}`,
              timestamp: Date.now(),
            });
          }
        }
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
      }

      // Legacy format fallback (subtype-based)
      if (msg.subtype === 'text' && msg.text) {
        agent.messages.push({
          id: uuid(),
          role: 'assistant',
          content: msg.text,
          timestamp: Date.now(),
        });
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
      }
      if (msg.subtype === 'tool_use') {
        agent.messages.push({
          id: uuid(),
          role: 'tool',
          content: `Using tool: ${msg.tool_name || 'unknown'}`,
          timestamp: Date.now(),
        });
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
      }
    }

    // Track context window usage from system messages
    const anyMsg = msg as Record<string, unknown>;
    if (anyMsg.num_turns !== undefined || anyMsg.session_id !== undefined) {
      // Claude verbose stream includes context info
      const contextUsed = (anyMsg.input_tokens_used as number) || 0;
      const contextTotal = (anyMsg.max_input_tokens as number) || 200000;
      if (contextUsed > 0) {
        agent.contextWindow = { used: contextUsed, total: contextTotal };
        this.store.saveAgent(agent);
      }
    }

    // Extract PR URLs from assistant messages
    if (msg.type === 'assistant') {
      const message = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            const prUrl = this.extractPrUrl(block.text);
            if (prUrl && !agent.prUrl) {
              agent.prUrl = prUrl;
              this.store.saveAgent(agent);
            }
          }
        }
      }
      if (msg.text) {
        const prUrl = this.extractPrUrl(msg.text);
        if (prUrl && !agent.prUrl) {
          agent.prUrl = prUrl;
          this.store.saveAgent(agent);
        }
      }
    }

    if (msg.type === 'result') {
      // Cost is at top level with --verbose: total_cost_usd
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd || msg.result?.cost_usd;
      if (cost) {
        agent.costUsd = cost;
      }

      // Extract context window from result
      const resultMsg = msg as Record<string, unknown>;
      const inputTokens = (resultMsg.total_input_tokens as number) || (resultMsg.input_tokens_used as number);
      const maxTokens = (resultMsg.max_input_tokens as number) || 200000;
      if (inputTokens) {
        agent.contextWindow = { used: inputTokens, total: maxTokens };
      }

      this.updateAgentStatus(agent.id, 'stopped');

      // Claude -p with stream-json doesn't exit after result; kill the process
      const proc = this.processes.get(agent.id);
      if (proc) {
        proc.stop();
      }
    }

    if (this.isClaudePermissionPrompt(msg)) {
      this.handleWaitingInput(agent, msg);
    }
  }

  private handleCodexMessage(agent: Agent, msg: StreamMessage): void {
    // Codex JSONL events: thread.started, turn.started, item.started, item.completed, turn.completed
    if (msg.type === 'item.completed' && msg.item) {
      if (msg.item.type === 'agent_message') {
        agent.messages.push({
          id: uuid(),
          role: 'assistant',
          content: msg.item.text || '',
          timestamp: Date.now(),
        });
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
      } else if (msg.item.type === 'command_execution' || msg.item.type === 'tool_call' || msg.item.type === 'function_call') {
        const item = msg.item as { type?: string; command?: string; aggregated_output?: string; exit_code?: number; text?: string };
        const content = item.command
          ? `Command: ${item.command}${item.aggregated_output ? `\nOutput: ${item.aggregated_output}` : ''}${item.exit_code !== undefined ? ` (exit: ${item.exit_code})` : ''}`
          : `Tool: ${item.text || JSON.stringify(msg.item)}`;
        agent.messages.push({
          id: uuid(),
          role: 'tool',
          content,
          timestamp: Date.now(),
        });
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
      } else if (msg.item.type === 'reasoning') {
        agent.messages.push({
          id: uuid(),
          role: 'system',
          content: msg.item.text || '',
          timestamp: Date.now(),
        });
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
      }
    }

    if (msg.type === 'turn.completed') {
      if (msg.usage) {
        agent.tokenUsage = {
          input: (agent.tokenUsage?.input || 0) + (msg.usage.input_tokens || 0),
          output: (agent.tokenUsage?.output || 0) + (msg.usage.output_tokens || 0),
        };
        this.store.saveAgent(agent);
      }
    }
  }

  private parseMcpServers(mcpConfigPath?: string): string[] {
    if (!mcpConfigPath) return [];
    try {
      const content = readFileSync(mcpConfigPath, 'utf-8');
      const config = JSON.parse(content);
      // MCP config has { mcpServers: { "name": { ... } } } format
      const servers = config.mcpServers || config;
      return Object.keys(servers);
    } catch {
      return [];
    }
  }

  private extractPrUrl(text: string): string | undefined {
    // Match GitHub/GitLab PR URLs
    const prPattern = /https?:\/\/(?:github\.com|gitlab\.com)\/[^\s]+\/pull\/\d+/;
    const match = text.match(prPattern);
    return match?.[0];
  }

  private isClaudePermissionPrompt(msg: StreamMessage): boolean {
    if (msg.type === 'assistant' && msg.subtype === 'permission') return true;
    const text = (msg.text || '').toLowerCase();
    return text.includes('permission') && text.includes('allow');
  }

  private extractInputPrompt(msg: StreamMessage): { prompt: string; choices?: string[] } {
    const text = msg.text || msg.item?.text || '';
    const choices: string[] = [];

    // Claude permission prompts typically offer Yes/No/Always
    if (msg.subtype === 'permission' || (text.toLowerCase().includes('permission') && text.toLowerCase().includes('allow'))) {
      choices.push('Yes', 'No', 'Always allow');
    }

    // Detect numbered choices (1. Option A  2. Option B)
    const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;
    let match;
    while ((match = numberedPattern.exec(text)) !== null) {
      choices.push(match[2].trim());
    }

    // Detect (y/n) style prompts
    if (/\(y\/n\)/i.test(text)) {
      if (choices.length === 0) choices.push('Yes', 'No');
    }

    return { prompt: text, choices: choices.length > 0 ? choices : undefined };
  }

  private handleWaitingInput(agent: Agent, msg: StreamMessage): void {
    this.updateAgentStatus(agent.id, 'waiting_input');

    // Extract prompt and choices for the web UI
    const inputInfo = this.extractInputPrompt(msg);
    this.emit('agent:input_required', agent.id, inputInfo);

    const notificationMessage = `Agent is waiting for permission/input.\nLast message: ${msg.text || msg.item?.text || JSON.stringify(msg)}`;
    if (agent.config.adminEmail) {
      this.emailNotifier.notifyHumanNeeded(
        agent.config.adminEmail,
        agent.name,
        notificationMessage,
      );
    }
    if (agent.config.whatsappPhone) {
      this.whatsappNotifier.notifyHumanNeeded(
        agent.config.whatsappPhone,
        agent.name,
        notificationMessage,
      );
    }
    if (agent.config.slackWebhookUrl) {
      this.slackNotifier.notifyHumanNeeded(
        agent.name,
        notificationMessage,
        agent.config.slackWebhookUrl,
      );
    }
  }

  private updateAgentStatus(agentId: string, status: AgentStatus): void {
    const agent = this.store.getAgent(agentId);
    if (agent) {
      agent.status = status;
      agent.lastActivity = Date.now();
      this.store.saveAgent(agent);
      this.emit('agent:status', agentId, status);
      this.emit('agent:update', agentId, agent);
    }
  }

  renameAgent(agentId: string, newName: string): void {
    const agent = this.store.getAgent(agentId);
    if (agent) {
      agent.name = newName;
      agent.lastActivity = Date.now();
      this.store.saveAgent(agent);
      this.emit('agent:status', agentId, agent.status);
    }
  }

  sendMessage(agentId: string, text: string): void {
    const proc = this.processes.get(agentId);
    if (proc) {
      const agent = this.store.getAgent(agentId);
      if (agent) {
        agent.messages.push({
          id: uuid(),
          role: 'user',
          content: text,
          timestamp: Date.now(),
        });
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
        // Emit full snapshot so chat UI updates immediately with user message
        this.emit('agent:update', agentId, agent);
      }
      proc.sendMessage(text);
      this.emit('agent:message', agentId, {
        type: 'user',
        text,
      });
    }
  }

  interruptAgent(agentId: string): void {
    const proc = this.processes.get(agentId);
    if (proc) {
      proc.interrupt();
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc) {
      proc.stop();
    }
    this.updateAgentStatus(agentId, 'stopped');
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.stopAgent(agentId);
    const agent = this.store.getAgent(agentId);
    if (agent?.worktreePath && agent.worktreeBranch) {
      try {
        this.worktreeManager.removeWorktree(
          agent.config.directory,
          agent.worktreePath,
          agent.worktreeBranch,
        );
      } catch (err) {
        console.warn('[AgentManager] Worktree cleanup failed:', err);
      }
    }
    this.store.deleteAgent(agentId);
  }

  async stopAllAgents(): Promise<void> {
    const agents = this.store.getAllAgents();
    for (const agent of agents) {
      if (agent.status === 'running' || agent.status === 'waiting_input') {
        await this.stopAgent(agent.id);
      }
    }
  }

  updateClaudeMd(agentId: string, content: string): void {
    const agent = this.store.getAgent(agentId);
    if (agent?.worktreePath) {
      this.worktreeManager.updateClaudeMd(agent.worktreePath, content);
    }
  }

  getAgent(agentId: string): Agent | undefined {
    return this.store.getAgent(agentId);
  }

  getAllAgents(): Agent[] {
    return this.store.getAllAgents();
  }

  async cleanupExpiredAgents(retentionMs: number): Promise<number> {
    if (retentionMs <= 0) return 0;
    const now = Date.now();
    const agents = this.store.getAllAgents();
    let count = 0;
    for (const agent of agents) {
      if (
        (agent.status === 'stopped' || agent.status === 'error') &&
        agent.lastActivity + retentionMs < now
      ) {
        await this.deleteAgent(agent.id);
        count++;
      }
    }
    return count;
  }
}
