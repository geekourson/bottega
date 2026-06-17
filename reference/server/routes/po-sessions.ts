import express, { type Request, type Response } from 'express';
import { tasksDb } from '../database/db.js';
import { getProject } from '../services/projectService.js';
import { startAgentRun } from '../services/agentRunner.js';
import { ProviderCredentialsMissingError } from '../services/credentials/types.js';
import type { ApiError } from '../../shared/api/_common.js';
import type { ServerToClientMessage } from '../../shared/websocket/messages.js';

const router = express.Router();

export interface StartPoSessionResponse {
  taskId: number;
  conversationId: number;
}

/**
 * POST /api/projects/:projectId/po-sessions
 *
 * Creates a dedicated "PO Session" task for the project and immediately
 * starts the PO agent on it. Returns the task and conversation IDs so
 * the frontend can redirect straight to the chat.
 */
router.post(
  '/projects/:projectId/po-sessions',
  async (
    req: Request<{ projectId: string }>,
    res: Response<StartPoSessionResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const projectId = parseInt(req.params.projectId, 10);

      if (isNaN(projectId)) {
        return res.status(400).json({ error: 'Invalid project ID' });
      }

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Create a dedicated PO session task (no worktree — pure planning)
      const now = new Date().toISOString().slice(0, 10);
      const created = tasksDb.create(projectId, `Session PO – ${now}`, false, userId);
      tasksDb.updateStatus(created.id, 'in_progress');

      const broadcastToConversationSubscribers =
        req.app.locals.broadcastToConversationSubscribers as
          | ((convId: number, msg: ServerToClientMessage) => void)
          | undefined;
      const broadcastFn = (convId: number, msg: ServerToClientMessage): void => {
        if (broadcastToConversationSubscribers) {
          broadcastToConversationSubscribers(convId, msg);
        }
      };
      const broadcastToTaskSubscribersFn = req.app.locals.broadcastToTaskSubscribers;

      const { conversation } = await startAgentRun(created.id, 'po', {
        broadcastFn,
        broadcastToTaskSubscribersFn,
        userId,
      });

      res.status(201).json({
        taskId: created.id,
        conversationId: conversation.id,
      });
    } catch (error) {
      if (error instanceof ProviderCredentialsMissingError) {
        const providerLabel =
          error.provider === 'openai'
            ? 'OpenAI'
            : error.provider === 'opencode'
              ? 'OpenCode'
              : 'Claude';
        res.status(403).json({
          error: `${providerLabel} credentials are not provisioned for this user. Connect ${providerLabel} in Settings → Providers.`,
        });
        return;
      }
      const msg = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error('Error starting PO session:', msg);
      res.status(500).json({ error: `Failed to start PO session: ${msg}` });
    }
  },
);

export default router;
