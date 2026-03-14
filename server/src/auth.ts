import { Router, Request, Response, NextFunction } from 'express';
// @ts-ignore - default import works at runtime with tsx
import jwt from 'jsonwebtoken';
import { config } from './config.js';

const JWT_EXPIRY = '24h';

function getJwtSecret(): string {
  // Use password itself as secret; it's only used for local session tokens
  return config.password || 'agent-monitor-local';
}

/** Create auth routes: login, logout, session check */
export function createAuthRoutes(): Router {
  const router = Router();

  // POST /api/auth/login
  router.post('/login', (req: Request, res: Response) => {
    const { password } = req.body ?? {};
    if (!config.password) {
      return res.json({ ok: true });
    }
    if (password !== config.password) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = jwt.sign({ local: true }, getJwtSecret(), { expiresIn: JWT_EXPIRY });
    res.cookie('auth_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  });

  // GET /api/auth/check
  router.get('/check', (req: Request, res: Response) => {
    if (!config.password) {
      return res.json({ authenticated: true });
    }
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ authenticated: false });
    }
    try {
      jwt.verify(token, getJwtSecret());
      return res.json({ authenticated: true });
    } catch {
      return res.status(401).json({ authenticated: false });
    }
  });

  // POST /api/auth/logout
  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie('auth_token', { path: '/' });
    return res.json({ ok: true });
  });

  return router;
}

/** Extract JWT token from cookie or Authorization header */
function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.auth_token;
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

/** Middleware: require valid JWT for protected routes */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.password) {
    next();
    return;
  }

  // Allow auth routes through
  if (req.path.startsWith('/api/auth/')) {
    next();
    return;
  }

  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    jwt.verify(token, getJwtSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
