import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentStore } from '../src/store/AgentStore.js';
import { ExternalAgentScanner } from '../src/services/ExternalAgentScanner.js';

describe('ExternalAgentScanner codex support', () => {
  let tmpHome: string;
  let tmpData: string;
  let originalHome: string | undefined;
  let store: AgentStore;
  let scanner: ExternalAgentScanner;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-home-'));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-data-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    store = new AgentStore(tmpData);
    scanner = new ExternalAgentScanner(store, () => new Set(), { autoImport: true, maxMessages: 50 });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it('imports codex session history, tool calls, and token usage from ~/.codex/sessions', () => {
    const cwd = path.join(tmpHome, 'project-codex');
    const sessionId = '019d5000-aaaa-7bbb-8ccc-1234567890ab';
    const sessionDir = path.join(tmpHome, '.codex', 'sessions', '2026', '04', '01');
    const sessionPath = path.join(sessionDir, `rollout-2026-04-01T10-00-00-${sessionId}.jsonl`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: '2026-04-01T15:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd, cli_version: '0.117.0' },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T15:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hello from codex' },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T15:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: 'call_1',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'pwd'], workdir: cwd }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T15:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: JSON.stringify({ output: `${cwd}\n`, metadata: { exit_code: 0, duration_seconds: 0.2 } }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T15:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'codex says hi' },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T15:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 12, output_tokens: 5 },
            model_context_window: 272000,
          },
        },
      }),
    ].join('\n'));

    const agent = (scanner as unknown as {
      importProcess: (proc: {
        pid: number;
        provider: 'codex';
        args: string;
        cwd: string;
        flags: Record<string, boolean | string>;
        prompt?: string;
        model?: string;
        sessionId?: string;
      }) => ReturnType<ExternalAgentScanner['importByPid']>;
    }).importProcess({
      pid: 99999,
      provider: 'codex',
      args: `codex exec --cd '${cwd}'`,
      cwd,
      flags: {},
    });

    expect(agent).not.toBeNull();
    expect(agent?.sessionId).toBe(sessionId);
    expect(agent?.config.directory).toBe(cwd);
    expect(agent?.messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant']);
    expect(agent?.messages[0].content).toBe('hello from codex');
    expect(agent?.messages[1].toolResult).toContain(cwd);
    expect(agent?.messages[2].content).toBe('codex says hi');
    expect(agent?.tokenUsage).toEqual({ input: 12, output: 5 });
    expect(agent?.contextWindow).toEqual({ used: 17, total: 272000 });
  });

  it('finds codex sessions by session id from ~/.codex/sessions', () => {
    const sessionId = '019d5000-aaaa-7bbb-8ccc-abcdefabcdef';
    const sessionDir = path.join(tmpHome, '.codex', 'sessions', '2026', '04', '01');
    const sessionPath = path.join(sessionDir, `rollout-2026-04-01T11-00-00-${sessionId}.jsonl`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({
      timestamp: '2026-04-01T16:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/tmp/codex-project' },
    }));

    const located = (scanner as unknown as {
      findSessionFileById: (provider: 'codex', sessionId: string, cwd: string) => string | null;
    }).findSessionFileById('codex', sessionId, '/tmp/codex-project');

    expect(located).toBe(sessionPath);
  });

  it('tails codex sessions and appends new messages/results from manual sessions', () => {
    const cwd = path.join(tmpHome, 'project-codex-tail');
    const sessionId = '019d5000-aaaa-7bbb-8ccc-feedfeedfeed';
    const sessionDir = path.join(tmpHome, '.codex', 'sessions', '2026', '04', '01');
    const sessionPath = path.join(sessionDir, `rollout-2026-04-01T12-00-00-${sessionId}.jsonl`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: '2026-04-01T17:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd, cli_version: '0.117.0' },
      }),
      JSON.stringify({
        timestamp: '2026-04-01T17:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'initial question' },
      }),
    ].join('\n'));

    const imported = (scanner as unknown as {
      importProcess: (proc: {
        pid: number;
        provider: 'codex';
        args: string;
        cwd: string;
        flags: Record<string, boolean | string>;
      }) => ReturnType<ExternalAgentScanner['importByPid']>;
    }).importProcess({
      pid: 99998,
      provider: 'codex',
      args: `codex exec --cd '${cwd}'`,
      cwd,
      flags: {},
    });

    expect(imported).not.toBeNull();
    expect(imported?.messages).toHaveLength(1);

    fs.appendFileSync(sessionPath, `\n${JSON.stringify({
      timestamp: '2026-04-01T17:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        call_id: 'tail_call_1',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'echo tail'], workdir: cwd }),
      },
    })}`);
    fs.appendFileSync(sessionPath, `\n${JSON.stringify({
      timestamp: '2026-04-01T17:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'tail_call_1',
        output: JSON.stringify({ output: 'tail\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }),
      },
    })}`);
    fs.appendFileSync(sessionPath, `\n${JSON.stringify({
      timestamp: '2026-04-01T17:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'tail answer' },
    })}`);

    const deltaCount = (scanner as unknown as {
      tailMessages: (agent: NonNullable<typeof imported>) => number;
    }).tailMessages(imported as NonNullable<typeof imported>);

    expect(deltaCount).toBeGreaterThan(0);
    const reloaded = store.getAgent(imported!.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant']);
    expect(reloaded?.messages[1].toolResult).toContain('tail');
    expect(reloaded?.messages[2].content).toBe('tail answer');
  });
});
