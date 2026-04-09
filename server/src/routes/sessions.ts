import { Router } from 'express';
import type { AgentProvider } from '../models/Agent.js';
import { SessionReader } from '../services/SessionReader.js';

export function sessionRoutes(): Router {
  const router = Router();
  const reader = new SessionReader();

  router.get('/', (req, res) => {
    try {
      const provider: AgentProvider = req.query.provider === 'codex' ? 'codex' : 'claude';
      const sessions = reader.listSessions(provider);
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
