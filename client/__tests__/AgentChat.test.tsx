import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentChat } from '../src/pages/AgentChat';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  sendMessage: vi.fn(),
  updateAgentPermissions: vi.fn(),
  updateClaudeMd: vi.fn(),
  stopAgent: vi.fn(),
  interruptAgent: vi.fn(),
  renameAgent: vi.fn(),
  getAgents: vi.fn(),
  getTasks: vi.fn(),
  socket: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../src/api/client', () => ({
  api: {
    getAgent: mocks.getAgent,
    sendMessage: mocks.sendMessage,
    updateAgentPermissions: mocks.updateAgentPermissions,
    updateClaudeMd: mocks.updateClaudeMd,
    stopAgent: mocks.stopAgent,
    interruptAgent: mocks.interruptAgent,
    renameAgent: mocks.renameAgent,
    getAgents: mocks.getAgents,
    getTasks: mocks.getTasks,
  },
}));

vi.mock('../src/api/socket', () => ({
  getSocket: () => mocks.socket,
  joinAgent: vi.fn(),
  leaveAgent: vi.fn(),
}));

vi.mock('../src/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        {
          'common.loading': 'Loading...',
          'common.stop': 'Stop',
          'common.save': 'Save',
          'common.cancel': 'Cancel',
          'common.send': 'Send',
          'common.tokens': 'tokens',
          'chat.inputPlaceholder': 'Type a message or / for commands...',
          'chat.escHint': 'Press Esc twice to interrupt the agent',
          'chat.slashAgents': 'agents',
          'chat.slashClear': 'clear',
          'chat.slashCompact': 'compact',
          'chat.slashConfig': 'config',
          'chat.slashContext': 'context',
          'chat.slashCopy': 'copy',
          'chat.slashCost': 'cost',
          'chat.slashDoctor': 'doctor',
          'chat.slashExit': 'exit',
          'chat.slashExport': 'export',
          'chat.slashHelp': 'help',
          'chat.slashModel': 'model',
          'chat.slashPermissions': 'permissions',
          'chat.slashPlan': 'plan',
          'chat.slashPlugin': 'plugin',
          'chat.slashRename': 'rename',
          'chat.slashSkills': 'skills',
          'chat.slashStats': 'stats',
          'chat.slashStatus': 'status',
          'chat.slashStop': 'stop',
          'chat.slashTasks': 'tasks',
          'chat.slashTheme': 'theme',
          'chat.slashTodos': 'todos',
          'chat.slashUsage': 'usage',
        } as Record<string, string>
      )[key] ?? key,
  }),
}));

describe('AgentChat permission actions', () => {
  beforeEach(() => {
    mocks.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Claude Agent',
      status: 'waiting_input',
      config: {
        provider: 'claude',
        directory: '/tmp/project',
        prompt: 'test',
        flags: { permissionMode: 'default' },
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'I need permission to write a file.',
          timestamp: 123,
        },
      ],
      lastActivity: 123,
      createdAt: 100,
    });
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.updateAgentPermissions.mockResolvedValue(undefined);
    mocks.socket.on.mockReset();
    mocks.socket.off.mockReset();
  });

  it('shows allow and deny buttons and sends approval text', async () => {
    render(
      <MemoryRouter initialEntries={['/agent/agent-1']}>
        <Routes>
          <Route path="/agent/:id" element={<AgentChat />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Permission Required')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Allow'));
    expect(mocks.sendMessage).toHaveBeenCalledWith('agent-1', 'Yes, approve this request.');

    fireEvent.click(screen.getByText('Deny'));
    expect(mocks.sendMessage).toHaveBeenCalledWith('agent-1', 'No, do not approve this request.');
  });

  it('updates permission mode from the conversation UI', async () => {
    mocks.getAgent.mockResolvedValueOnce({
      id: 'agent-2',
      name: 'Codex Agent',
      status: 'stopped',
      config: {
        provider: 'codex',
        directory: '/tmp/project',
        prompt: 'test',
        flags: { permissionMode: 'readOnly' },
      },
      messages: [],
      lastActivity: 123,
      createdAt: 100,
    });

    render(
      <MemoryRouter initialEntries={['/agent/agent-2']}>
        <Routes>
          <Route path="/agent/:id" element={<AgentChat />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Permissions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Permissions'));
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'fullAuto' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mocks.updateAgentPermissions).toHaveBeenCalledWith('agent-2', 'fullAuto');
    });
  });
});
