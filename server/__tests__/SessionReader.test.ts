import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionReader } from '../src/services/SessionReader.js';

describe('SessionReader', () => {
  let tmpDir: string;
  let claudeDir: string;
  let codexDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reader-test-'));
    claudeDir = path.join(tmpDir, '.claude', 'projects');
    codexDir = path.join(tmpDir, '.codex', 'sessions');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists Claude sessions by default', () => {
    const projectDir = path.join(claudeDir, 'tmp-my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'claude-session.jsonl'), JSON.stringify({
      type: 'user',
      message: { content: 'hello' },
    }));

    const reader = new SessionReader(claudeDir, codexDir);
    const sessions = reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'claude-session',
      projectPath: 'tmp/my/project',
    });
  });

  it('lists Codex sessions recursively with cwd metadata', () => {
    const cwd = path.join(tmpDir, 'project-codex');
    const sessionId = '019d5000-aaaa-7bbb-8ccc-1234567890ab';
    const sessionDir = path.join(codexDir, '2026', '04', '09');
    const sessionPath = path.join(sessionDir, `rollout-2026-04-09T12-00-00-${sessionId}.jsonl`);

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'resume me' },
      }),
    ].join('\n'));

    const reader = new SessionReader(claudeDir, codexDir);
    const sessions = reader.listSessions('codex');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      projectPath: cwd,
    });
  });
});
