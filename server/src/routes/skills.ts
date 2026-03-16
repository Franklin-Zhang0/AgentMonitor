import { Router } from 'express';
import { existsSync, readdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

interface InstalledSkill {
  name: string;
  command: string;
  description: string;
  source: string;
}

type SkillProvider = 'claude' | 'codex';

function readSkillDescription(skillFilePath: string): string {
  try {
    const content = readFileSync(skillFilePath, 'utf-8');
    const frontmatterMatch = content.match(/description:\s*"([^"]+)"/);
    if (frontmatterMatch?.[1]) {
      return frontmatterMatch[1];
    }

    const firstBodyLine = content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('---') && !line.startsWith('#'));

    return firstBodyLine || 'Installed skill';
  } catch {
    return 'Installed skill';
  }
}

function listSkillsInDir(skillRoot: string, source: string): InstalledSkill[] {
  if (!existsSync(skillRoot)) {
    return [];
  }

  return readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillFilePath = path.join(skillRoot, entry.name, 'SKILL.md');
      if (!existsSync(skillFilePath)) {
        return null;
      }

      return {
        name: entry.name,
        command: `/${entry.name}`,
        description: readSkillDescription(skillFilePath),
        source,
      };
    })
    .filter((skill): skill is InstalledSkill => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function skillRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const homeDir = os.homedir();
      const provider = req.query.provider as SkillProvider | undefined;
      const validProviders: SkillProvider[] = ['claude', 'codex'];
      if (provider && !validProviders.includes(provider)) {
        res.status(400).json({ error: `Invalid provider: ${provider}` });
        return;
      }

      const skillRoots: Record<SkillProvider, string> = {
        claude: path.join(homeDir, '.claude', 'skills'),
        codex: path.join(homeDir, '.codex', 'skills'),
      };
      const providers = provider ? [provider] : validProviders;
      const skills = providers.flatMap((skillProvider) =>
        listSkillsInDir(skillRoots[skillProvider], skillProvider),
      );
      const deduped = Array.from(
        new Map(skills.map((skill) => [skill.command, skill])).values(),
      ).sort((a, b) => a.name.localeCompare(b.name));

      res.json(deduped);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
