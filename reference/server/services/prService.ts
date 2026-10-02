/**
 * PR Service - Consolidates PR logic for manual button and PR agent
 *
 * This service provides a unified interface for PR operations used by:
 * - Manual "Create PR" button in the UI
 * - Automated PR agent
 */

import {
  hasUncommittedChanges,
  commitAllChanges,
  createPullRequest as worktreeCreatePR,
  getPullRequestStatus,
  getWorktreeStatus,
  squashBranchCommits,
} from './worktree.js';
import { projectSettingsDb } from '../database/db.js';
import type { TaskRow } from '../database/db.js';

export interface PRResult {
  success: boolean;
  url?: string | undefined;
  error?: string | undefined;
}

export interface CIStatusResult {
  success: boolean;
  url?: string | undefined;
  ciStatus?: unknown;
  mergeable?: string | undefined;
  error?: string | undefined;
}

/**
 * Create or update a PR for a task
 * Used by both manual button and PR agent
 */
export async function createOrUpdatePR(
  repoPath: string,
  taskId: number,
  title: string,
  body: string,
  userId?: number,
  projectId?: number,
): Promise<PRResult> {
  // 1. Check for uncommitted changes -> commit
  const changesResult = await hasUncommittedChanges(repoPath, taskId);
  if (changesResult.success && changesResult.hasChanges) {
    const commitResult = await commitAllChanges(repoPath, taskId, title);
    if (!commitResult.success) {
      return { success: false, error: `Failed to commit: ${commitResult.error}` };
    }
  }

  // 2. Check commits ahead of main
  const statusResult = await getWorktreeStatus(repoPath, taskId);
  if (statusResult.success && statusResult.ahead === 0) {
    return { success: false, error: 'No changes to create a PR' };
  }

  // 3. Repositories that keep one commit per PR: squash the branch first.
  let squashed = false;
  if (projectId != null && isSquashBeforePr(projectId)) {
    const squash = await squashBranchCommits(repoPath, taskId, title);
    if (!squash.success) {
      return { success: false, error: `Failed to squash commits: ${squash.error}` };
    }
    squashed = (squash.squashed ?? 0) > 0;
  }

  // 4. Create PR
  return worktreeCreatePR(repoPath, taskId, title, body, userId, projectId, squashed);
}

/** Project setting: squash a task's commits into one before opening its PR. */
export function isSquashBeforePr(projectId: number): boolean {
  return projectSettingsDb.getValue(projectId, 'squash_before_pr') === '1';
}

/**
 * Get CI status and failure details for a task's PR
 */
export async function getCIStatusWithDetails(
  repoPath: string,
  taskId: number,
): Promise<CIStatusResult> {
  const prStatus = await getPullRequestStatus(repoPath, taskId);
  if (!prStatus.success || !prStatus.exists) {
    return { success: false, error: 'No PR found' };
  }
  return {
    success: true,
    url: prStatus.url,
    ciStatus: prStatus.ciStatus,
    mergeable: prStatus.mergeable,
  };
}

/**
 * Check if PR agent should run for a task
 */
export function shouldRunPrAgent(task: Pick<TaskRow, 'workflow_complete' | 'pr_agent_complete'>): boolean {
  return task.workflow_complete === 1 && task.pr_agent_complete === 0;
}
