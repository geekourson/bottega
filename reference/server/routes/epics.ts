// HTTP surface of the multi-repo epics extra (extra/multi-repo-epics.md).
// Mounted under `/api` behind `authenticateToken`.

import express, { type Request, type Response } from 'express';
import { tasksDb } from '../database/db.js';
import { hasProjectAccess } from '../services/projectService.js';
import {
  EpicError,
  approveBreakdown,
  getEpicContext,
  getEpicOverview,
  setChildProjects,
} from '../services/epicService.js';
import { ProviderCredentialsMissingError } from '../services/credentials/types.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { IdParamsSchema, type IdParams } from '../../shared/schemas/_common.js';
import {
  ApproveBreakdownBodySchema,
  type ApproveBreakdownBody,
  SetChildProjectsBodySchema,
  type SetChildProjectsBody,
} from '../../shared/schemas/epics.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  ApproveBreakdownResponse,
  EpicContextResponse,
  EpicOverviewResponse,
  SetChildProjectsResponse,
} from '../../shared/api/epics.js';
import type {
  BroadcastToTaskSubscribersFn,
  ServerToClientMessage,
} from '../../shared/websocket/messages.js';

const router = express.Router();

function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof EpicError) {
    res.status(error.status).json({ error: error.message } satisfies ApiError);
    return;
  }
  console.error(`[Epics] ${fallback}:`, error);
  res.status(500).json({ error: fallback } satisfies ApiError);
}

/** 404 unless the caller is a member of the task's project. */
function canAccessTask(taskId: number, userId: number): boolean {
  const task = tasksDb.getById(taskId);
  return !!task && hasProjectAccess(task.project_id, userId);
}

function broadcastersFrom(req: Request) {
  const broadcastToConversationSubscribers = req.app.locals.broadcastToConversationSubscribers as
    | ((convId: number, msg: ServerToClientMessage) => void)
    | undefined;
  return {
    broadcastFn: (convId: number, msg: ServerToClientMessage): void => {
      broadcastToConversationSubscribers?.(convId, msg);
    },
    broadcastToTaskSubscribersFn: req.app.locals.broadcastToTaskSubscribers as
      | BroadcastToTaskSubscribersFn
      | undefined,
  };
}

router.put(
  '/projects/:id/children',
  validateParams(IdParamsSchema),
  validateBody(SetChildProjectsBodySchema),
  (req: Request, res: Response<SetChildProjectsResponse | ApiError>) => {
    try {
      const { id } = req.validated!.params as IdParams;
      const { childIds } = req.validated!.body as SetChildProjectsBody;
      res.json(setChildProjects(id, req.user!.id, childIds));
    } catch (error) {
      sendError(res, error, 'Failed to update child projects');
    }
  },
);

router.get(
  '/tasks/:id/epic',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<EpicOverviewResponse | ApiError>) => {
    try {
      const { id } = req.validated!.params as IdParams;
      if (!canAccessTask(id, req.user!.id)) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(getEpicOverview(id));
    } catch (error) {
      sendError(res, error, 'Failed to load epic');
    }
  },
);

router.post(
  '/tasks/:id/breakdown/approve',
  validateParams(IdParamsSchema),
  validateBody(ApproveBreakdownBodySchema),
  async (req: Request, res: Response<ApproveBreakdownResponse | ApiError>) => {
    try {
      const { id } = req.validated!.params as IdParams;
      const { startPlanning } = req.validated!.body as ApproveBreakdownBody;
      if (!canAccessTask(id, req.user!.id)) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const result = await approveBreakdown(id, req.user!.id, {
        ...broadcastersFrom(req),
        startPlanning,
      });
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof ProviderCredentialsMissingError) {
        res.status(403).json({ error: error.message });
        return;
      }
      sendError(res, error, 'Failed to approve the breakdown');
    }
  },
);

router.get(
  '/tasks/:id/epic-context',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<EpicContextResponse | ApiError>) => {
    try {
      const { id } = req.validated!.params as IdParams;
      if (!canAccessTask(id, req.user!.id)) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(getEpicContext(id));
    } catch (error) {
      sendError(res, error, 'Failed to load epic context');
    }
  },
);

export default router;
