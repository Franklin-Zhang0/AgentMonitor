import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AgentProvider } from '../models/Agent.js';

export interface SessionInfo {
  id: string;
  projectPath: string;
  lastModified: number;
}

export class SessionReader {
  private claudeDir: string;
  private codexDir: string;

  constructor(claudeDir?: string, codexDir?: string) {
    this.claudeDir = claudeDir || path.join(os.homedir(), '.claude', 'projects');
    this.codexDir = codexDir || path.join(os.homedir(), '.codex', 'sessions');
  }

  listSessions(provider: AgentProvider = 'claude'): SessionInfo[] {
    return provider === 'codex'
      ? this.listCodexSessions()
      : this.listClaudeSessions();
  }

  private listClaudeSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    if (!fs.existsSync(this.claudeDir)) {
      return sessions;
    }

    const projectDirs = fs.readdirSync(this.claudeDir, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;

      const projectPath = path.join(this.claudeDir, dir.name);
      const files = fs.readdirSync(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(projectPath, file);
        const stat = fs.statSync(filePath);

        sessions.push({
          id: sessionId,
          projectPath: dir.name.replace(/-/g, '/'),
          lastModified: stat.mtimeMs,
        });
      }
    }

    return sessions.sort((a, b) => b.lastModified - a.lastModified);
  }

  private listCodexSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    if (!fs.existsSync(this.codexDir)) {
      return sessions;
    }

    for (const sessionPath of this.listCodexSessionFiles(this.codexDir)) {
      try {
        const stat = fs.statSync(sessionPath);
        const meta = this.readCodexSessionMeta(sessionPath);
        const sessionId = meta?.id || path.basename(sessionPath, '.jsonl');
        const projectPath = meta?.cwd || path.dirname(sessionPath);

        sessions.push({
          id: sessionId,
          projectPath,
          lastModified: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable session files.
      }
    }

    return sessions.sort((a, b) => b.lastModified - a.lastModified);
  }

  private listCodexSessionFiles(dir: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.listCodexSessionFiles(fullPath));
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore unreadable directories.
    }

    return files;
  }

  private readCodexSessionMeta(sessionPath: string): { id?: string; cwd?: string } | null {
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const firstLine = content.split('\n').find((line) => line.trim());
      if (!firstLine) return null;

      const entry = JSON.parse(firstLine) as {
        type?: string;
        payload?: { id?: string; cwd?: string };
      };
      if (entry.type !== 'session_meta') return null;

      return {
        id: entry.payload?.id,
        cwd: entry.payload?.cwd,
      };
    } catch {
      return null;
    }
  }
}
