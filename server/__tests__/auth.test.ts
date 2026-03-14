import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer, Server } from 'http';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

interface TestResponse {
  status: number;
  body: unknown;
  setCookie: string[];
}

function makeRequest(baseUrl: string) {
  return async (path: string, opts: RequestOptions = {}): Promise<TestResponse> => {
    const { method = 'GET', body, cookie, headers = {} } = opts;
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (cookie) reqHeaders['Cookie'] = cookie;

    const init: RequestInit = { method, headers: reqHeaders };
    if (body) init.body = JSON.stringify(body);

    const res = await fetch(`${baseUrl}${path}`, init);
    const json = await res.json().catch(() => null);
    return {
      status: res.status,
      body: json,
      setCookie: res.headers.getSetCookie?.() ?? [],
    };
  };
}

function extractCookie(setCookieHeaders: string[]): string | undefined {
  for (const h of setCookieHeaders) {
    if (h.startsWith('auth_token=')) return h.split(';')[0];
  }
  return undefined;
}

function computeSecret(password: string): string {
  return crypto.createHash('sha256').update(password || 'agent-monitor-local').digest('hex');
}

// ---------------------------------------------------------------------------
// Tests with password DISABLED
// ---------------------------------------------------------------------------

describe('Auth — no password', () => {
  let server: Server;
  let request: ReturnType<typeof makeRequest>;
  let createAuthRoutes: typeof import('../src/auth.js').createAuthRoutes;
  let requireAuth: typeof import('../src/auth.js').requireAuth;
  let verifyToken: typeof import('../src/auth.js').verifyToken;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: {
        password: '',
        relay: { token: '' },
      },
    }));
    const authMod = await import('../src/auth.js');
    createAuthRoutes = authMod.createAuthRoutes;
    requireAuth = authMod.requireAuth;
    verifyToken = authMod.verifyToken;

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes());
    app.use('/api', requireAuth);
    app.get('/api/protected', (_req, res) => res.json({ ok: true }));

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Bad address');
    request = makeRequest(`http://127.0.0.1:${addr.port}`);
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  // createAuthRoutes
  it('POST /login returns ok without requiring password', async () => {
    const res = await request('/api/auth/login', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /check returns authenticated: true', async () => {
    const res = await request('/api/auth/check');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });
  });

  // requireAuth
  it('allows access to protected route without credentials', async () => {
    const res = await request('/api/protected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // verifyToken — with no-password secret
  it('verifyToken returns true for a valid JWT', () => {
    const secret = computeSecret('');
    const token = jwt.sign({ local: true }, secret, { expiresIn: '1h' });
    expect(verifyToken(token)).toBe(true);
  });

  it('verifyToken returns false for an invalid JWT', () => {
    expect(verifyToken('garbage.token.here')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests with password ENABLED
// ---------------------------------------------------------------------------

describe('Auth — with password', () => {
  const TEST_PASSWORD = 'test-secret-123';
  const RELAY_TOKEN = 'relay-secret-456';

  let server: Server;
  let request: ReturnType<typeof makeRequest>;
  let createAuthRoutes: typeof import('../src/auth.js').createAuthRoutes;
  let requireAuth: typeof import('../src/auth.js').requireAuth;
  let verifyToken: typeof import('../src/auth.js').verifyToken;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: {
        password: TEST_PASSWORD,
        relay: { token: RELAY_TOKEN },
      },
    }));
    const authMod = await import('../src/auth.js');
    createAuthRoutes = authMod.createAuthRoutes;
    requireAuth = authMod.requireAuth;
    verifyToken = authMod.verifyToken;

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes());
    app.use('/api', requireAuth);
    app.get('/api/protected', (_req, res) => res.json({ ok: true }));

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Bad address');
    request = makeRequest(`http://127.0.0.1:${addr.port}`);
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  // ---- createAuthRoutes ----

  describe('POST /login', () => {
    it('returns ok with Set-Cookie on correct password', async () => {
      const res = await request('/api/auth/login', {
        method: 'POST',
        body: { password: TEST_PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const cookie = extractCookie(res.setCookie);
      expect(cookie).toBeDefined();
      expect(cookie).toContain('auth_token=');
    });

    it('returns 401 on wrong password', async () => {
      const res = await request('/api/auth/login', {
        method: 'POST',
        body: { password: 'wrong' },
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid password' });
    });
  });

  describe('GET /check', () => {
    it('returns authenticated with valid cookie', async () => {
      // Login first to get a cookie
      const loginRes = await request('/api/auth/login', {
        method: 'POST',
        body: { password: TEST_PASSWORD },
      });
      const cookie = extractCookie(loginRes.setCookie)!;

      const res = await request('/api/auth/check', { cookie });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authenticated: true });
    });

    it('returns 401 without cookie', async () => {
      const res = await request('/api/auth/check');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ authenticated: false });
    });
  });

  describe('POST /logout', () => {
    it('clears auth_token cookie', async () => {
      const res = await request('/api/auth/logout', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      // The cleared cookie should have an expiry in the past or max-age=0
      const cleared = res.setCookie.find((h) => h.startsWith('auth_token='));
      expect(cleared).toBeDefined();
    });
  });

  // ---- requireAuth middleware ----

  describe('requireAuth', () => {
    it('allows request with correct x-tunnel-auth header', async () => {
      const res = await request('/api/protected', {
        headers: { 'x-tunnel-auth': RELAY_TOKEN },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects request with wrong x-tunnel-auth header', async () => {
      const res = await request('/api/protected', {
        headers: { 'x-tunnel-auth': 'wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('allows /auth/ paths through without authentication', async () => {
      // /api/auth/check is mounted before requireAuth on /api,
      // but requireAuth checks req.path which starts with /auth/
      const res = await request('/api/auth/login', { method: 'POST' });
      // Should reach the login handler, not get blocked by requireAuth
      expect(res.status).toBe(401); // wrong password, but NOT "Authentication required"
      expect(res.body).toEqual({ error: 'Invalid password' });
    });

    it('allows request with valid Bearer token', async () => {
      const secret = computeSecret(TEST_PASSWORD);
      const token = jwt.sign({ local: true }, secret, { expiresIn: '1h' });
      const res = await request('/api/protected', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects request with invalid Bearer token', async () => {
      const res = await request('/api/protected', {
        headers: { Authorization: 'Bearer invalid.token.here' },
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or expired token' });
    });

    it('rejects request with no credentials', async () => {
      const res = await request('/api/protected');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
    });
  });

  // ---- verifyToken ----

  describe('verifyToken', () => {
    it('returns true for a valid JWT', () => {
      const secret = computeSecret(TEST_PASSWORD);
      const token = jwt.sign({ local: true }, secret, { expiresIn: '1h' });
      expect(verifyToken(token)).toBe(true);
    });

    it('returns false for a tampered JWT', () => {
      const secret = computeSecret(TEST_PASSWORD);
      const token = jwt.sign({ local: true }, secret, { expiresIn: '1h' });
      // Flip a character in the signature
      const tampered = token.slice(0, -2) + 'xx';
      expect(verifyToken(tampered)).toBe(false);
    });

    it('returns false for an expired JWT', () => {
      const secret = computeSecret(TEST_PASSWORD);
      const token = jwt.sign({ local: true }, secret, { expiresIn: '-1s' });
      expect(verifyToken(token)).toBe(false);
    });
  });

  // ---- Integration flow ----

  describe('login → access → logout → denied flow', () => {
    it('completes the full auth lifecycle', async () => {
      // 1. Login
      const loginRes = await request('/api/auth/login', {
        method: 'POST',
        body: { password: TEST_PASSWORD },
      });
      expect(loginRes.status).toBe(200);
      const cookie = extractCookie(loginRes.setCookie)!;
      expect(cookie).toBeDefined();

      // 2. Access protected route with cookie
      const protectedRes = await request('/api/protected', { cookie });
      expect(protectedRes.status).toBe(200);
      expect(protectedRes.body).toEqual({ ok: true });

      // 3. Logout
      const logoutRes = await request('/api/auth/logout', {
        method: 'POST',
        cookie,
      });
      expect(logoutRes.status).toBe(200);

      // 4. Access protected route without cookie → denied
      const deniedRes = await request('/api/protected');
      expect(deniedRes.status).toBe(401);
      expect(deniedRes.body).toEqual({ error: 'Authentication required' });
    });
  });
});
