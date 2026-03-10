import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../src/pages/Dashboard';

const mocks = vi.hoisted(() => ({
  getAgents: vi.fn(),
  getSettings: vi.fn(),
  socketHandlers: new Map<string, Set<(...args: unknown[]) => void>>(),
}));

vi.mock('../src/api/client', () => ({
  api: {
    getAgents: mocks.getAgents,
    getSettings: mocks.getSettings,
    stopAllAgents: vi.fn(),
    deleteAgent: vi.fn(),
    stopAgent: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

vi.mock('../src/api/socket', () => ({
  getSocket: () => ({
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = mocks.socketHandlers.get(event) ?? new Set();
      handlers.add(handler);
      mocks.socketHandlers.set(event, handlers);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      mocks.socketHandlers.get(event)?.delete(handler);
    },
  }),
}));

vi.mock('../src/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        {
          'common.loading': 'Loading...',
          'dashboard.title': 'Dashboard',
          'dashboard.newAgent': '+ New Agent',
          'dashboard.stopAll': 'Stop All',
          'dashboard.empty': 'No agents running. Create one to get started.',
          'dashboard.noMessages': 'No messages yet',
          'dashboard.searchLabel': 'Search agents by name',
          'dashboard.searchPlaceholder': 'Search agents by name...',
          'dashboard.noSearchResults': 'No agents match that search.',
          'dashboard.settings': 'Settings',
          'dashboard.retentionHours': 'Retention',
          'dashboard.retentionDisabled': 'Disabled',
          'common.stop': 'Stop',
          'common.delete': 'Delete',
          'common.cancel': 'Cancel',
          'common.save': 'Save',
        } as Record<string, string>
      )[key] ?? key,
  }),
}));

describe('Dashboard', () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ agentRetentionMs: 86_400_000 });
    mocks.getAgents.mockResolvedValue([
      {
        id: '1',
        name: 'Older Agent',
        status: 'running',
        config: { provider: 'codex', directory: '/tmp/a', prompt: 'a', flags: {} },
        messages: [{ id: 'm1', role: 'assistant', content: 'older reply', timestamp: 1000 }],
        lastActivity: 1000,
        createdAt: 500,
      },
      {
        id: '2',
        name: 'Newest Agent',
        status: 'waiting_input',
        config: { provider: 'codex', directory: '/tmp/b', prompt: 'b', flags: {} },
        messages: [{ id: 'm2', role: 'assistant', content: 'newer reply', timestamp: 3000 }],
        lastActivity: 3000,
        createdAt: 1500,
      },
      {
        id: '3',
        name: 'No Reply Yet',
        status: 'stopped',
        config: { provider: 'claude', directory: '/tmp/c', prompt: 'c', flags: {} },
        messages: [{ id: 'm3', role: 'user', content: 'hello', timestamp: 2500 }],
        lastActivity: 2500,
        createdAt: 2000,
      },
    ]);
    mocks.socketHandlers.clear();
  });

  it('sorts by most recent reply time and filters by name', async () => {
    const { container } = render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Newest Agent')).toBeInTheDocument();
    });

    const names = [...container.querySelectorAll('.card-name')].map((el) => el.textContent?.trim());
    expect(names).toEqual([
      'CODEX Newest Agent',
      'CLAUDE No Reply Yet',
      'CODEX Older Agent',
    ]);

    fireEvent.change(screen.getByLabelText('Search agents by name'), { target: { value: 'new' } });

    expect(screen.getByText('Newest Agent')).toBeInTheDocument();
    expect(screen.queryByText('Older Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('No Reply Yet')).not.toBeInTheDocument();
  });
});
