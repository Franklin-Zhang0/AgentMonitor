import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const UPLOAD_DIR = '/tmp/agentmonitor-uploads';

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

export function uploadRoutes(): Router {
  const router = Router();

  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    res.json({ path: req.file.path, originalName: req.file.originalname, size: req.file.size });
  });

  return router;
}
