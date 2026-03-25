import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { homedir } from 'os';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import type { Agent, AgentProvider } from '../models/Agent.js';
import type { AgentStore } from '../store/AgentStore.js';

interface DiscoveredProcess {
  pid: number;
  provider: AgentProvider;
  args: string;
  cwd: string;
  sessionId?: string;
  prompt?: string;
  model?: string;
  flags: Record<string, boolean | string>;
}

interface ScanResult {
  imported: Agent[];
  updated: number;
  removed: number;
}

/**
 * Discovers and monitors claude/codex agents running on the local machine
 * that were NOT started by AgentMonitor.
 */
export class ExternalAgentScanner extends EventEmitter {
  private store: AgentStore;
  private interval: ReturnType<typeof setInterval> | null = null;
  private dismissedPids = new Set<number>();
  private tailOffsets = new Map<string, number>(); // agentId -> byte offset
  private scanIntervalMs: number;
  private autoImport: boolean;
  private maxMessages: number;
  private managedPids: () => Set<number>;

  constructor(
    store: AgentStore,
    getManagedPids: () => Set<number>,
    opts?: { scanIntervalMs?: number; autoImport?: boolean; maxMessages?: number },
  ) {
    super();
    this.store = store;
    this.managedPids = getManagedPids;
    this.scanIntervalMs = opts?.scanIntervalMs ?? 15_000;
    this.autoImport = opts?.autoImport ?? true;
    this.maxMessages = opts?.maxMessages ?? 200;
  }

  start(): void {
    if (this.interval) return;
    // Initial scan after short delay
    setTimeout(() => this.scan(), 2000);
    this.interval = setInterval(() => this.scan(), this.scanIntervalMs);
    console.log(`[ExternalScanner] Started (interval: ${this.scanIntervalMs}ms, autoImport: ${this.autoImport})`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  dismiss(pid: number): void {
    this.dismissedPids.add(pid);
  }

  /**
   * Run a single scan cycle: discover processes, import/update/cleanup.
   */
  scan(): ScanResult {
    const result: ScanResult = { imported: [], updated: 0, removed: 0 };
    try {
      const processes = this.discoverProcesses();
      const tracked = this.managedPids();

      // Import new external processes
      for (const proc of processes) {
        if (tracked.has(proc.pid) || this.dismissedPids.has(proc.pid)) continue;
        if (this.isAlreadyTracked(proc)) continue;

        if (this.autoImport) {
          const agent = this.importProcess(proc);
          if (agent) {
            result.imported.push(agent);
          }
        }
      }

      // Update existing external agents
      const runningPids = new Set(processes.map(p => p.pid));
      for (const agent of this.store.getAllAgents()) {
        if (agent.source !== 'external') continue;

        if (agent.status === 'running' && agent.pid) {
          if (!runningPids.has(agent.pid) && !this.isProcessAlive(agent.pid)) {
            // Process died
            agent.status = 'stopped';
            agent.pid = undefined;
            this.store.saveAgent(agent);
            this.emit('agent:status', agent.id, 'stopped');
            this.emit('agent:update', agent.id, agent);
            result.removed++;
          } else {
            // Still running — tail JSONL for new messages
            const newMsgs = this.tailMessages(agent);
            if (newMsgs > 0) {
              result.updated++;
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ExternalScanner] Scan error:', err);
    }
    return result;
  }

  /**
   * Get list of candidate processes not yet imported.
   */
  getCandidates(): DiscoveredProcess[] {
    const processes = this.discoverProcesses();
    const tracked = this.managedPids();
    return processes.filter(p =>
      !tracked.has(p.pid) &&
      !this.dismissedPids.has(p.pid) &&
      !this.isAlreadyTracked(p),
    );
  }

  /**
   * Import a specific process by PID.
   */
  importByPid(pid: number): Agent | null {
    const processes = this.discoverProcesses();
    const proc = processes.find(p => p.pid === pid);
    if (!proc) return null;
    return this.importProcess(proc);
  }

  // --- Private methods ---

  private discoverProcesses(): DiscoveredProcess[] {
    const results: DiscoveredProcess[] = [];
    try {
      // Only scan current user's processes to avoid permission issues
      const uid = process.getuid?.() ?? 0;
      const psOutput = execSync(
        `ps -u ${uid} -o pid,args --no-headers`,
        { encoding: 'utf-8', timeout: 5000 },
      );

      for (const line of psOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx < 0) continue;

        const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
        const args = trimmed.slice(spaceIdx + 1).trim();

        // Skip non-claude/codex processes
        if (!this.isClaudeOrCodex(args)) continue;
        // Skip grep/ps itself
        if (args.includes('grep') || args.includes(' ps ')) continue;
        // Skip AgentMonitor's own server
        if (args.includes('server/src/index')) continue;

        const parsed = this.parseArgs(args, pid);
        if (parsed) results.push(parsed);
      }
    } catch {
      // ps failed — likely no running processes
    }
    return results;
  }

  private isClaudeOrCodex(args: string): boolean {
    // Match: node/.../claude, claude -p, codex exec, etc.
    // But NOT: "claude-code-guide", "claude.md", shell-snapshot scripts
    return (
      (/\bclaude\b/.test(args) && (args.includes(' -p ') || args.includes('--resume') || args.includes('stream-json'))) ||
      (/\bcodex\b/.test(args) && args.includes('exec'))
    );
  }

  private parseArgs(args: string, pid: number): DiscoveredProcess | null {
    const isClaude = /\bclaude\b/.test(args) && !(/\bcodex\b/.test(args) && args.includes('exec'));
    const isCodex = /\bcodex\b/.test(args) && args.includes('exec');
    const provider: AgentProvider = isCodex ? 'codex' : 'claude';

    // Get cwd from /proc
    let cwd = '';
    try {
      cwd = readFileSync(`/proc/${pid}/cwd`, 'utf-8').trim();
    } catch {
      try {
        cwd = execSync(`readlink /proc/${pid}/cwd`, { encoding: 'utf-8', timeout: 2000 }).trim();
      } catch {
        // Can't determine cwd
      }
    }

    // Extract flags
    const flags: Record<string, boolean | string> = {};
    const sessionMatch = args.match(/--resume\s+(\S+)/);
    const modelMatch = args.match(/--model\s+(\S+)/);
    const promptMatch = args.match(/-p\s+'([^']*)'/) || args.match(/-p\s+"([^"]*)"/);

    if (args.includes('--dangerously-skip-permissions')) flags.dangerouslySkipPermissions = true;
    if (args.includes('--chrome')) flags.chrome = true;
    if (args.includes('--full-auto')) flags.fullAuto = true;

    const sessionId = sessionMatch?.[1];
    const model = modelMatch?.[1];
    let prompt = promptMatch?.[1] || '';

    // For codex, extract prompt after 'exec'
    if (isCodex && !prompt) {
      const execMatch = args.match(/exec\s+(?:--\S+\s+\S+\s+)*'([^']+)'/);
      prompt = execMatch?.[1] || '';
    }

    return { pid, provider, args, cwd, sessionId, prompt, model, flags };
  }

  private isAlreadyTracked(proc: DiscoveredProcess): boolean {
    const agents = this.store.getAllAgents();
    for (const agent of agents) {
      if (agent.pid === proc.pid) return true;
      if (proc.sessionId && agent.sessionId === proc.sessionId) return true;
    }
    return false;
  }

  private importProcess(proc: DiscoveredProcess): Agent | null {
    // Try to find session file and load messages
    const sessionInfo = this.findSessionFile(proc);
    const messages = sessionInfo?.jsonlPath
      ? this.parseJsonlMessages(sessionInfo.jsonlPath)
      : [];

    const firstUserMsg = messages.find(m => m.role === 'user');
    const promptText = proc.prompt || firstUserMsg?.content || '(external agent)';
    const dirName = proc.cwd ? basename(proc.cwd) : 'unknown';

    const agent: Agent = {
      id: uuid(),
      name: `${dirName} (${proc.provider})`,
      status: 'running',
      config: {
        provider: proc.provider,
        directory: proc.cwd || '/',
        prompt: promptText,
        flags: {
          dangerouslySkipPermissions: !!proc.flags.dangerouslySkipPermissions,
          model: proc.model,
          resume: proc.sessionId,
          fullAuto: !!proc.flags.fullAuto,
          chrome: !!proc.flags.chrome,
        },
      },
      messages: messages.slice(-this.maxMessages),
      lastActivity: Date.now(),
      createdAt: Date.now(),
      pid: proc.pid,
      sessionId: sessionInfo?.sessionId || proc.sessionId,
      projectName: dirName,
      currentTask: promptText.length > 120 ? promptText.slice(0, 120) + '...' : promptText,
      originalPrompt: promptText,
      source: 'external',
    };

    this.store.saveAgent(agent);
    this.emit('agent:update', agent.id, agent);
    console.log(`[ExternalScanner] Imported: ${agent.name} (PID: ${proc.pid}, session: ${agent.sessionId || 'none'})`);
    return agent;
  }

  private findSessionFile(proc: DiscoveredProcess): { sessionId: string; jsonlPath: string } | null {
    if (!proc.cwd) return null;
    const claudeDir = resolve(homedir(), '.claude', 'projects');
    if (!existsSync(claudeDir)) return null;

    // Encode cwd to match Claude's directory naming
    const encoded = proc.cwd.replace(/\//g, '-');
    const projectDir = resolve(claudeDir, encoded);

    if (!existsSync(projectDir)) return null;

    // If we have a session ID, look for that specific file
    if (proc.sessionId) {
      const jsonlPath = resolve(projectDir, `${proc.sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        return { sessionId: proc.sessionId, jsonlPath };
      }
    }

    // Otherwise find the most recently modified JSONL
    try {
      const files = readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: resolve(projectDir, f),
          mtime: statSync(resolve(projectDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const sessionId = files[0].name.replace('.jsonl', '');
        return { sessionId, jsonlPath: files[0].path };
      }
    } catch {
      // Can't read directory
    }
    return null;
  }

  private parseJsonlMessages(jsonlPath: string): Agent['messages'] {
    const messages: Agent['messages'] = [];
    try {
      const content = readFileSync(jsonlPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const msg = this.jsonlEntryToMessage(entry);
          if (msg) messages.push(msg);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Can't read file
    }
    return messages;
  }

  private jsonlEntryToMessage(entry: Record<string, unknown>): Agent['messages'][0] | null {
    const type = entry.type as string;
    const ts = entry.timestamp ? new Date(entry.timestamp as string).getTime() : Date.now();

    if (type === 'user') {
      const msg = entry.message as { content?: string } | undefined;
      const content = typeof msg?.content === 'string' ? msg.content : '';
      if (!content) return null;
      return { id: (entry.uuid as string) || uuid(), role: 'user', content, timestamp: ts };
    }

    if (type === 'assistant') {
      const msg = entry.message as { content?: unknown[] } | undefined;
      if (!msg?.content || !Array.isArray(msg.content)) return null;
      // Extract text blocks
      const textParts: string[] = [];
      for (const block of msg.content) {
        if (typeof block === 'string') textParts.push(block);
        else if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
          if (b.type === 'tool_use') {
            return {
              id: (b.id as string) || uuid(),
              role: 'tool',
              content: b.name as string || 'tool',
              toolName: b.name as string,
              toolInput: typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {}),
              timestamp: ts,
            };
          }
        }
      }
      const content = textParts.join('\n');
      if (!content) return null;
      return { id: (entry.uuid as string) || uuid(), role: 'assistant', content, timestamp: ts };
    }

    if (type === 'tool_result' || type === 'tool') {
      const content = typeof entry.content === 'string'
        ? entry.content
        : JSON.stringify(entry.content || '');
      return {
        id: (entry.uuid as string) || uuid(),
        role: 'tool',
        content: content.slice(0, 500),
        toolName: (entry.tool_name as string) || 'tool',
        toolResult: content.slice(0, 2000),
        timestamp: ts,
      };
    }

    return null;
  }

  /**
   * Tail-read new messages from an external agent's JSONL.
   */
  private tailMessages(agent: Agent): number {
    if (!agent.sessionId) return 0;
    const sessionFile = this.findSessionFileById(agent.sessionId, agent.config.directory);
    if (!sessionFile) return 0;

    const offset = this.tailOffsets.get(agent.id) ?? 0;
    let fileSize: number;
    try {
      fileSize = statSync(sessionFile).size;
    } catch { return 0; }

    if (fileSize <= offset) return 0;

    try {
      const fd = require('fs').openSync(sessionFile, 'r');
      const buf = Buffer.alloc(fileSize - offset);
      require('fs').readSync(fd, buf, 0, buf.length, offset);
      require('fs').closeSync(fd);

      const newContent = buf.toString('utf-8');
      const newMessages: Agent['messages'] = [];

      for (const line of newContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const msg = this.jsonlEntryToMessage(entry);
          if (msg) newMessages.push(msg);
        } catch { /* skip */ }
      }

      if (newMessages.length > 0) {
        agent.messages.push(...newMessages);
        // Cap message history
        if (agent.messages.length > this.maxMessages * 2) {
          agent.messages = agent.messages.slice(-this.maxMessages);
        }
        agent.lastActivity = Date.now();
        this.store.saveAgent(agent);
        this.emit('agent:delta', agent.id, { newMessages, agent });
        this.emit('agent:update', agent.id, agent);
      }

      this.tailOffsets.set(agent.id, fileSize);
      return newMessages.length;
    } catch {
      return 0;
    }
  }

  private findSessionFileById(sessionId: string, cwd: string): string | null {
    const claudeDir = resolve(homedir(), '.claude', 'projects');
    if (!existsSync(claudeDir)) return null;

    const encoded = cwd.replace(/\//g, '-');
    const jsonlPath = resolve(claudeDir, encoded, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) return jsonlPath;

    // Scan all project dirs for this session ID
    try {
      for (const dir of readdirSync(claudeDir)) {
        const p = resolve(claudeDir, dir, `${sessionId}.jsonl`);
        if (existsSync(p)) return p;
      }
    } catch { /* */ }
    return null;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
