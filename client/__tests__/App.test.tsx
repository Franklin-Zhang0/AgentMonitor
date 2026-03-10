import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { App } from '../src/App';

vi.mock('../src/hooks/useAuth', () => ({
  useAuth: () => ({
    authenticated: true,
    loading: false,
    logout: async () => {},
  }),
}));

vi.mock('../src/pages/Dashboard', () => ({
  Dashboard: () => <div>Dashboard Page</div>,
}));

vi.mock('../src/pages/CreateAgent', () => ({
  CreateAgent: () => <div>Create Agent Page</div>,
}));

vi.mock('../src/pages/AgentChat', () => ({
  AgentChat: () => <div>Agent Chat Page</div>,
}));

vi.mock('../src/pages/Templates', () => ({
  Templates: () => <div>Templates Page</div>,
}));

vi.mock('../src/pages/Pipeline', () => ({
  Pipeline: () => <div>Pipeline Page</div>,
}));

vi.mock('../src/pages/Login', () => ({
  Login: () => <div>Login Page</div>,
}));

describe('App', () => {
  it('renders navigation', () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );
    expect(screen.getByText('Agent Monitor')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('New Agent')).toBeInTheDocument();
    expect(screen.getByText('Templates')).toBeInTheDocument();
  });
});
