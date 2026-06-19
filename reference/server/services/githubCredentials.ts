import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectSettingsDb } from '../database/db.js';

const DEFAULT_GITHUB_CONFIG_ROOT = path.join(os.homedir(), '.config', 'bottega', 'users');
const GITHUB_TOKEN_FILE_NAME = 'github_token';

export function getGitHubTokenPath(userId: number | string): string {
  const userDir = path.join(DEFAULT_GITHUB_CONFIG_ROOT, String(userId));
  return path.join(userDir, GITHUB_TOKEN_FILE_NAME);
}

export function readGitHubToken(userId: number | string): string | null {
  const tokenPath = getGitHubTokenPath(userId);
  try {
    const content = fs.readFileSync(tokenPath, 'utf8').trim();
    return content || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeGitHubToken(userId: number | string, token: string): void {
  const userDir = path.join(DEFAULT_GITHUB_CONFIG_ROOT, String(userId));
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const tokenPath = getGitHubTokenPath(userId);
  fs.writeFileSync(tokenPath, token.trim(), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

export function clearGitHubToken(userId: number | string): boolean {
  const tokenPath = getGitHubTokenPath(userId);
  try {
    fs.unlinkSync(tokenPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Get the effective GitHub token: project-level override first, then user-level file.
 */
export function getGitHubToken(userId: number | string, projectId?: number): string | null {
  if (projectId !== undefined) {
    try {
      const projectToken = projectSettingsDb.getValue(projectId, 'github_token');
      if (projectToken) return projectToken;
    } catch {
      // fall through to user token
    }
  }
  return readGitHubToken(userId);
}
