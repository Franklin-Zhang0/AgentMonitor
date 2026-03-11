import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { DirectoryBrowser } from '../services/DirectoryBrowser.js';

export function directoryRoutes(): Router {
  const router = Router();
  const browser = new DirectoryBrowser();

  router.get('/', (req, res) => {
    try {
      const dirPath = (req.query.path as string) || process.env.HOME || '/';
      const entries = browser.listDirectory(dirPath);
      const parent = browser.getParent(dirPath);
      res.json({ path: dirPath, parent, entries });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/claude-md', (req, res) => {
    try {
      const dirPath = req.query.path as string;
      if (!dirPath) {
        res.json({ exists: false });
        return;
      }
      const claudeMdPath = path.join(dirPath, 'CLAUDE.md');
      if (existsSync(claudeMdPath)) {
        const content = readFileSync(claudeMdPath, 'utf-8');
        res.json({ exists: true, content });
      } else {
        res.json({ exists: false });
      }
    } catch (err) {
      res.json({ exists: false });
    }
  });

  return router;
}
