import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class WorktreeManager {
  createWorktree(
    repoDir: string,
    branchName: string,
    claudeMd?: string,
  ): { worktreePath: string; branch: string } {
    const worktreeBase = path.join(repoDir, '.agent-worktrees');
    fs.mkdirSync(worktreeBase, { recursive: true });

    const worktreePath = path.join(worktreeBase, branchName);

    // Verify the directory is a git repo (caller should check before calling)
    execSync('git rev-parse --git-dir', { cwd: repoDir, stdio: 'pipe' });

    // Create the worktree
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
      cwd: repoDir,
      stdio: 'pipe',
    });

    // Write CLAUDE.md if provided
    if (claudeMd) {
      fs.writeFileSync(path.join(worktreePath, 'CLAUDE.md'), claudeMd);
    }

    return { worktreePath, branch: branchName };
  }

  removeWorktree(repoDir: string, worktreePath: string, branchName: string): void {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: repoDir,
        stdio: 'pipe',
      });
    } catch {
      // worktree may already be gone
    }
    try {
      execSync(`git branch -D "${branchName}"`, {
        cwd: repoDir,
        stdio: 'pipe',
      });
    } catch {
      // branch may already be gone
    }
  }

  updateClaudeMd(worktreePath: string, content: string): void {
    fs.writeFileSync(path.join(worktreePath, 'CLAUDE.md'), content);
  }

  getClaudeMd(worktreePath: string): string | null {
    const filePath = path.join(worktreePath, 'CLAUDE.md');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  }
}
