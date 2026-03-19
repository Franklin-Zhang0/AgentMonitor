import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path, { basename } from 'path';
import os from 'os';
import type { Agent, AgentConfig, AgentMessage, AgentStatus } from '../models/Agent.js';
import { AgentStore } from '../store/AgentStore.js';
import { AgentProcess, type StreamMessage } from './AgentProcess.js';
import { WorktreeManager } from './WorktreeManager.js';
import { EmailNotifier } from './EmailNotifier.js';
import { WhatsAppNotifier } from './WhatsAppNotifier.js';
import { SlackNotifier } from './SlackNotifier.js';
import { FeishuNotifier } from './FeishuNotifier.js';

function getInstructionFileName(provider: AgentConfig['provider']): string {
  return provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
}

export class AgentManager extends EventEmitter {
  private processes: Map<string, AgentProcess> = new Map();
  private pendingRestartPrompts: Map<string, string> = new Map();
  private store: AgentStore;
  private worktreeManager: WorktreeManager;
  private emailNotifier: EmailNotifier;
  private whatsappNotifier: WhatsAppNotifier;
  private slackNotifier: SlackNotifier;
  private feishuNotifier: FeishuNotifier;

  constructor(store: AgentStore, worktreeManager?: WorktreeManager, emailNotifier?: EmailNotifier, whatsappNotifier?: WhatsAppNotifier, slackNotifier?: SlackNotifier, feishuNotifier?: FeishuNotifier) {
    super();
    this.store = store;
    this.worktreeManager = worktreeManager || new WorktreeManager();
    this.emailNotifier = emailNotifier || new EmailNotifier();
    this.whatsappNotifier = whatsappNotifier || new WhatsAppNotifier();
    this.slackNotifier = slackNotifier || new SlackNotifier();
    this.feishuNotifier = feishuNotifier || new FeishuNotifier('', '');
  }

  async createAgent(name: string, agentConfig: AgentConfig): Promise<Agent> {
    const id = uuid();
    const branchName = `agent-${id.slice(0, 8)}`;

    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    // Ensure working directory exists (create if needed)
    if (!existsSync(agentConfig.directory)) {
      mkdirSync(agentConfig.directory, { recursive: true });
      console.log(`[AgentManager] Created missing directory: ${agentConfig.directory}`);
    }

    // Create git worktree for isolation — only if the directory is already a git repo
    const isGitRepo = (() => {
      try {
        execSync('git rev-parse --git-dir', { cwd: agentConfig.directory, stdio: 'pipe' });
        return true;
      } catch { return false; }
    })();

    if (isGitRepo) {
      try {
        const result = this.worktreeManager.createWorktree(
          agentConfig.directory,
          branchName,
          agentConfig.claudeMd,
          agentConfig.provider,
        );
        worktreePath = result.worktreePath;
        worktreeBranch = result.branch;
      } catch (err) {
        console.warn('[AgentManager] Worktree creation failed, using directory directly:', err);
        worktreePath = agentConfig.directory;
        if (agentConfig.claudeMd) {
          writeFileSync(
            path.join(worktreePath, getInstructionFileName(agentConfig.provider)),
            agentConfig.claudeMd,
          );
        }
      }
    } else {
      // Not a git repo — work directly in the directory, no worktree needed.
      worktreePath = agentConfig.directory;
      // Write the provider-specific instruction file directly into the working directory.
      if (agentConfig.claudeMd) {
        writeFileSync(
          path.join(worktreePath, getInstructionFileName(agentConfig.provider)),
          agentConfig.claudeMd,
        );
      }
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
    this.store.recordPath(os.hostname(), agentConfig.directory);
    this.startProcess(agent);

    // Notify dashboard of newly created agent immediately
    this.emit('agent:update', agent.id, agent);

    return agent;
  }

  private startProcess(agent: Agent, promptOverride?: string): void {
    const proc = new AgentProcess();
    this.processes.set(agent.id, proc);

    proc.on('message', (msg: StreamMessage) => {
      this.handleStreamMessage(agent.id, msg, agent.config.provider);
    });

    proc.on('terminal', (chunk: { stream: string; data: string }) => {
      this.emit('agent:terminal', agent.id, chunk);
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
      if (this.pendingRestartPrompts.has(agent.id)) {
        const restartPrompt = this.pendingRestartPrompts.get(agent.id) ?? '';
        this.pendingRestartPrompts.delete(agent.id);
        this.processes.delete(agent.id);

        const current = this.store.getAgent(agent.id);
        if (current) {
          current.status = 'running';
          current.lastActivity = Date.now();
          this.store.saveAgent(current);
          this.startProcess(current, restartPrompt);
        }
        return;
      }

      // Don't override 'stopped' status (set when result message is received)
      const current = this.store.getAgent(agent.id);
      if (current && current.status !== 'stopped') {
        const status = (code === 0 || code === null) ? 'stopped' : 'error';
        if (status === 'error') {
          current.messages.push({
            id: uuid(),
            role: 'system',
            content: `Agent process exited with code ${code}`,
            timestamp: Date.now(),
          });
          this.store.saveAgent(current);
        }
        this.updateAgentStatus(agent.id, status);
      }
      this.processes.delete(agent.id);
    });

    proc.on('error', (err: Error) => {
      console.error(`[Agent ${agent.id}] process error:`, err);
      const a = this.store.getAgent(agent.id);
      if (a) {
        a.messages.push({
          id: uuid(),
          role: 'system',
          content: `Process error: ${err.message}`,
          timestamp: Date.now(),
        });
        this.store.saveAgent(a);
      }
      this.updateAgentStatus(agent.id, 'error');
    });

    proc.start({
      provider: agent.config.provider,
      directory: agent.worktreePath || agent.config.directory,
      prompt: promptOverride ?? agent.config.prompt,
      dangerouslySkipPermissions: agent.config.flags.dangerouslySkipPermissions,
      resume: agent.config.flags.resume,
      model: agent.config.flags.model,
      effort: agent.config.flags.effort,
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
    // Claude may emit session id on init/result events at different JSON locations.
    const sessionId = msg.result?.session_id || msg.session_id;
    if (sessionId && agent.config.flags.resume !== sessionId) {
      agent.config.flags.resume = sessionId;
      this.store.saveAgent(agent);
    }

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
            const inputStr = block.input ? (typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)) : '';
            agent.messages.push({
              id: uuid(),
              role: 'tool',
              content: `Using tool: ${block.name || 'unknown'}`,
              toolName: block.name || 'unknown',
              toolInput: inputStr.length > 5000 ? inputStr.slice(0, 5000) + '\n...(truncated)' : inputStr,
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

    // Capture tool results from 'user' type messages (Claude sends tool results as user messages)
    if (msg.type === 'user') {
      const userMessage = msg.message as { content?: Array<{ type: string; content?: string; tool_use_id?: string }> } | undefined;
      const toolResult = msg.tool_use_result as { stdout?: string; stderr?: string } | undefined;
      if (userMessage?.content) {
        for (const block of userMessage.content) {
          if (block.type === 'tool_result') {
            let resultText = '';
            if (toolResult?.stdout) resultText = toolResult.stdout;
            else if (typeof block.content === 'string') resultText = block.content;
            if (resultText) {
              // Attach result to the most recent tool message without a result
              const lastToolMsg = [...agent.messages].reverse().find(m => m.role === 'tool' && !m.toolResult);
              if (lastToolMsg) {
                lastToolMsg.toolResult = resultText.length > 10000 ? resultText.slice(0, 10000) + '\n...(truncated)' : resultText;
                if (toolResult?.stderr) {
                  lastToolMsg.toolResult += '\n[stderr] ' + toolResult.stderr;
                }
                this.store.saveAgent(agent);
              }
            }
          }
        }
      }
    }

    // Track context window usage from system messages
    const anyMsg = msg as Record<string, unknown>;
    if (anyMsg.num_turns !== undefined || anyMsg.session_id !== undefined) {
      // Claude verbose stream includes context info and session_id
      if (anyMsg.session_id && typeof anyMsg.session_id === 'string') {
        agent.sessionId = anyMsg.session_id;
      }
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

      // Store session ID for resume capability
      const resultAny = msg as Record<string, unknown>;
      const sessionId = msg.result?.session_id || (resultAny.session_id as string);
      if (sessionId) {
        agent.sessionId = sessionId;
      }

      // Extract context window from result
      const resultMsg = msg as Record<string, unknown>;
      const inputTokens = (resultMsg.total_input_tokens as number) || (resultMsg.input_tokens_used as number);
      const maxTokens = (resultMsg.max_input_tokens as number) || 200000;
      if (inputTokens) {
        agent.contextWindow = { used: inputTokens, total: maxTokens };
      }
      this.store.saveAgent(agent);
      this.updateAgentStatus(agent.id, 'stopped');

      // In interactive stdin mode, Claude waits for more input after result;
      // kill the process so the agent is truly stopped.
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
    const codexThreadId =
      msg.thread_id ||
      msg.thread?.id ||
      (msg.type === 'thread.started' ? (msg as { id?: string }).id : undefined);
    if (codexThreadId && agent.config.flags.resume !== codexThreadId) {
      agent.config.flags.resume = codexThreadId;
      this.store.saveAgent(agent);
    }

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

  private getMsgText(msg: StreamMessage): string {
    if (msg.text) return msg.text as string;
    if (msg.item?.text) return msg.item.text;
    // Extract from stream-json message.content blocks
    const message = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (message?.content) {
      return message.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n');
    }
    return '';
  }

  private isClaudePermissionPrompt(msg: StreamMessage): boolean {
    if (msg.type === 'assistant' && msg.subtype === 'permission') return true;
    const text = this.getMsgText(msg).toLowerCase();
    return text.includes('permission') && text.includes('allow');
  }

  private extractInputPrompt(msg: StreamMessage): { prompt: string; choices?: string[] } {
    const text = this.getMsgText(msg) || msg.item?.text || '';
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
    if (agent.config.feishuChatId) {
      this.feishuNotifier.notifyHumanNeeded(
        agent.config.feishuChatId,
        agent,
        inputInfo.choices,
      );
    }
  }

  private buildReplayPrompt(agent: Agent): string {
    const transcript = agent.messages
      .filter((message) => message.role !== 'system')
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');

    return [
      'Resume this conversation from the transcript below.',
      `Original task: ${agent.config.prompt}`,
      transcript ? `Conversation transcript:\n${transcript}` : '',
      'Continue from the latest USER message. Do not restate the transcript unless needed.',
    ]
      .filter(Boolean)
      .join('\n\n');
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

  updatePermissionMode(agentId: string, permissionMode?: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;

    agent.config.flags.permissionMode = permissionMode || undefined;

    if (agent.config.provider === 'codex') {
      agent.config.flags.fullAuto = permissionMode === 'fullAuto' ? true : undefined;
      agent.config.flags.dangerouslySkipPermissions = permissionMode === 'bypassPermissions' ? true : undefined;
    } else {
      agent.config.flags.dangerouslySkipPermissions =
        permissionMode === 'bypassPermissions' || permissionMode === 'dontAsk' ? true : undefined;
    }

    agent.lastActivity = Date.now();
    this.store.saveAgent(agent);
    this.emit('agent:update', agentId, agent);
    this.restartAgentWithResume(agentId);
  }

  sendMessage(agentId: string, text: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;

    // Add user message to history
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

    const proc = this.processes.get(agentId);
    if (agent.config.provider === 'claude' && proc?.isRunning) {
      // Claude keeps stdin open, so normal follow-up turns stay on the same process.
      if (agent.status === 'waiting_input') {
        this.updateAgentStatus(agentId, 'running');
      }
      proc.sendMessage(text);
      this.emit('agent:message', agentId, {
        type: 'user',
        text,
      });
      return;
    }

    if (agent.status === 'stopped' || agent.status === 'error') {
      if (this.canResumeStoppedSession(agent)) {
        this.resumeAgent(agent, text);
      } else {
        this.updateAgentStatus(agentId, 'running');
        this.startProcess(agent, this.buildReplayPrompt(agent));
      }
      this.emit('agent:message', agentId, {
        type: 'user',
        text,
      });
      return;
    }

    // Codex remains one-shot (`codex exec`). If there is no live process, restart from transcript.
    this.updateAgentStatus(agentId, 'running');
    const nextPrompt = agent.config.flags.resume ? text : this.buildReplayPrompt(agent);
    this.startProcess(agent, nextPrompt);
    this.emit('agent:message', agentId, {
      type: 'user',
      text,
    });
  }

  private resumeAgent(agent: Agent, newPrompt: string): void {
    console.log(`[AgentManager] Resuming agent ${agent.id} (session: ${agent.sessionId || 'none'})`);

    // Update the prompt to the new one
    agent.config.prompt = newPrompt;
    agent.currentTask = newPrompt.length > 120 ? newPrompt.slice(0, 120) + '...' : newPrompt;

    // If we have a session ID, use --resume to continue the conversation
    if (agent.sessionId && agent.config.provider === 'claude') {
      agent.config.flags.resume = agent.sessionId;
    }

    this.updateAgentStatus(agent.id, 'running');
    this.startProcess(agent);
  }

  private canResumeStoppedSession(agent: Agent): boolean {
    if (agent.config.provider === 'claude') {
      return Boolean(agent.sessionId);
    }
    return Boolean(agent.config.flags.resume);
  }

  private restartAgentWithResume(agentId: string): void {
    const agent = this.store.getAgent(agentId);
    const proc = this.processes.get(agentId);
    if (!agent || agent.config.provider !== 'claude' || !proc?.isRunning) {
      return;
    }

    if (agent.sessionId) {
      agent.config.flags.resume = agent.sessionId;
    }

    this.pendingRestartPrompts.set(agentId, '');
    this.updateAgentStatus(agentId, 'running');
    proc.stop();
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
    this.emit('agent:status', agentId, 'deleted');
  }

  async stopAllAgents(): Promise<void> {
    const agents = this.store.getAllAgents();
    for (const agent of agents) {
      if (agent.status === 'running' || agent.status === 'waiting_input') {
        await this.stopAgent(agent.id);
      }
    }
  }

  async rewindToMessage(agentId: string, messageId: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;

    const targetIndex = agent.messages.findIndex(
      (message) => message.id === messageId && message.role === 'user',
    );
    if (targetIndex === -1) {
      throw new Error('User message not found');
    }

    const proc = this.processes.get(agentId);
    if (proc) {
      this.pendingRestartPrompts.delete(agentId);
      proc.stop();
      this.processes.delete(agentId);
    }

    // Rewind to just before the selected user turn. The selected message is
    // restored into the chat input on the client for editing/resend.
    agent.messages = agent.messages.slice(0, targetIndex);
    agent.sessionId = undefined;
    agent.config.flags.resume = undefined;
    agent.status = 'stopped';
    agent.lastActivity = Date.now();
    agent.costUsd = undefined;
    agent.tokenUsage = undefined;
    this.store.saveAgent(agent);

    this.emit('agent:status', agentId, agent.status);
    this.emit('agent:update', agentId, agent);
  }

  updateClaudeMd(agentId: string, content: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;

    agent.config.claudeMd = content;
    agent.lastActivity = Date.now();
    this.store.saveAgent(agent);

    if (agent.worktreePath) {
      this.worktreeManager.updateClaudeMd(agent.worktreePath, content, agent.config.provider);
    }

    this.emit('agent:update', agentId, agent);
    this.restartAgentWithResume(agentId);
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
