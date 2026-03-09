import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAuth } from '../src/hooks/useAuth';

function AuthProbe() {
  const { authenticated, loading } = useAuth();

  if (loading) {
    return <div>loading</div>;
  }

  return <div>{authenticated ? 'authenticated' : 'unauthenticated'}</div>;
}

describe('useAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats missing auth route as local mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
      })),
    );

    render(
      <MemoryRouter>
        <AuthProbe />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('authenticated')).toBeInTheDocument();
    });
  });

  it('redirects to login when auth explicitly fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
      })),
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProbe />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('unauthenticated')).toBeInTheDocument();
    });
  });
});
