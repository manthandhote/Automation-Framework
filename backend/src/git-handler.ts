import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

export class GitHandler {
  private git: SimpleGit;

  constructor(private baseDir: string) {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    this.git = simpleGit(baseDir).env({
      'GIT_TERMINAL_PROMPT': '0'
    });
  }

  /**
   * Inject PAT token into Azure DevOps / HTTPS git URL
   * URL format: https://user:PAT@dev.azure.com/...
   * If GIT_PAT is set in .env, it is automatically embedded.
   */
  private injectAuth(repoUrl: string): string {
    const pat = process.env.GIT_PAT;
    if (!pat) return repoUrl;

    try {
      const url = new URL(repoUrl);
      // Only inject for HTTPS URLs (not SSH)
      if (url.protocol === 'https:') {
        // Azure DevOps: use 'pat' as username, PAT as password
        url.username = process.env.GIT_USERNAME || url.username || 'pat';
        url.password = pat;
        return url.toString();
      }
    } catch { /* invalid URL, return as-is */ }
    return repoUrl;
  }

  async cloneOrUpdate(repoUrl: string, folderName: string, branch: string = 'main', commitId?: string) {
    const targetPath  = path.join(this.baseDir, folderName);
    const authUrl     = this.injectAuth(repoUrl);

    if (fs.existsSync(targetPath)) {
      logger.info(`Updating existing repo in ${targetPath}...`, 'GIT');
      const repoGit = simpleGit(targetPath).env({
        'GIT_TERMINAL_PROMPT': '0'
      });
      await repoGit.fetch(['origin']);
      await repoGit.checkout(branch);
      await repoGit.pull('origin', branch);
      if (commitId) {
        await repoGit.reset(['--hard', commitId]);
      }
    } else {
      logger.info(`Cloning ${repoUrl} into ${targetPath} (branch: ${branch})...`, 'GIT');
      await this.git.clone(authUrl, folderName, ['--branch', branch, '--single-branch']);
      if (commitId) {
        const repoGit = simpleGit(targetPath).env({ 'GIT_TERMINAL_PROMPT': '0' });
        await repoGit.reset(['--hard', commitId]);
      }
    }

    const metadata = await this.getCommitMetadata(targetPath);
    return { targetPath, metadata };
  }

  async getCommitMetadata(targetPath: string): Promise<{ commit_id: string, author: string, message: string, timestamp: string }> {
    const repoGit = simpleGit(targetPath);
    const log = await repoGit.log({ maxCount: 1 });
    const latest = log.latest;
    return {
      commit_id: latest?.hash || '',
      author: latest?.author_name || '',
      message: latest?.message || '',
      timestamp: latest?.date || ''
    };
  }

  async listRemoteBranches(repoUrl: string): Promise<string[]> {
    const authUrl = this.injectAuth(repoUrl);
    try {
      const result = await this.git.listRemote(['--heads', authUrl]);
      // "hash\trefs/heads/branch-name\n..."
      return result.split('\n')
        .filter(line => line.trim())
        .map(line => line.split('refs/heads/')[1])
        .filter(Boolean);
    } catch (err) {
      console.error(err)
      console.warn(`[GIT] Could not list branches for ${repoUrl} — auth may be required. Returning empty list.`);
      return [];
    }
  }
}
