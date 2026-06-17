import express, { type Request, type Response } from 'express';
import { tasksDb, agentRunsDb } from '../database/db.js';
import { hasProjectAccess } from '../services/projectService.js';
import { startAgentRun, getRunningAgentForTask } from '../services/agentRunner.js';
import { ProviderCredentialsMissingError } from '../services/credentials/types.js';
import type { AgentType } from '../../shared/types/db.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  AgentRunConflictResponse,
  CompleteAgentRunResponse,
  CreateAgentRunRequest,
  CreateAgentRunResponse,
  DeleteAgentRunResponse,
  GetAgentRunResponse,
  LinkConversationRequest,
  LinkConversationResponse,
  ListAgentRunsResponse,
  StartPendingAgentsResponse,
} from '../../shared/api/agent-runs.js';
import type { ServerToClientMessage } from '../../shared/websocket/messages.js';

const router = express.Router();

const VALID_AGENT_TYPES: AgentType[] = [
  'planification',
  'implementation',
  'refinement',
  'review',
  'pr',
  'yolo',
  'po',
];

router.get(
  '/tasks/:taskId/agent-runs',
  (req: Request<{ taskId: string }>, res: Response<ListAgentRunsResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const taskId = parseInt(req.params.taskId, 10);

      if (isNaN(taskId)) {
        return res.status(400).json({ error: 'Invalid task ID' });
      }

      const taskWithProject = tasksDb.getWithProject(taskId);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const agentRuns = agentRunsDb.getByTask(taskId);
      res.json(agentRuns);
    } catch (error) {
      console.error('Error listing agent runs:', error);
      res.status(500).json({ error: 'Failed to list agent runs' });
    }
  },
);

router.post(
  '/tasks/:taskId/agent-runs',
  async (
    req: Request<
      { taskId: string },
      CreateAgentRunResponse | ApiError | AgentRunConflictResponse,
      CreateAgentRunRequest
    >,
    res: Response<CreateAgentRunResponse | ApiError | AgentRunConflictResponse>,
  ) => {
    try {
      const userId = req.user!.id;
      const taskId = parseInt(req.params.taskId, 10);
      const { agentType } = req.body;

      if (isNaN(taskId)) {
        return res.status(400).json({ error: 'Invalid task ID' });
      }

      if (!agentType || !VALID_AGENT_TYPES.includes(agentType)) {
        return res.status(400).json({
          error: `Invalid agent type. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`,
        });
      }

      const taskWithProject = tasksDb.getWithProject(taskId);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const runningRun = getRunningAgentForTask(taskId);
      if (runningRun) {
        return res.status(409).json({
          error: 'An agent is already running for this task',
          runningAgent: runningRun,
        });
      }

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

      const { agentRun } = await startAgentRun(taskId, agentType, {
        broadcastFn,
        broadcastToTaskSubscribersFn,
        userId,
      });

      res.status(201).json(agentRun);
    } catch (error) {
      if (error instanceof ProviderCredentialsMissingError) {
        // 403 = user needs to authenticate the configured provider.
        // The body carries `provider` so the frontend can open the
        // right tab in Settings → Providers.
        const providerLabel =
          error.provider === 'openai'
            ? 'OpenAI'
            : error.provider === 'opencode'
              ? 'OpenCode'
              : 'Claude';
        res.status(403).json({
          error: `${providerLabel} credentials are not provisioned for this user. Connect ${providerLabel} in Settings → Providers.`,
          code: 'PROVIDER_CREDENTIALS_MISSING',
          provider: error.provider,
        } as never);
        return;
      }
      console.error('Error starting agent run:', error);
      res.status(500).json({ error: 'Failed to start agent run' });
    }
  },
);

// Batch-start the first pipeline agent on every eligible pending task in a
// project. The auto-chaining loop then carries each task forward on its own.
router.post(
  '/projects/:projectId/agent-runs/start-pending',
  async (
    req: Request<{ projectId: string }>,
    res: Response<StartPendingAgentsResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const projectId = parseInt(req.params.projectId, 10);

      if (isNaN(projectId)) {
        return res.status(400).json({ error: 'Invalid project ID' });
      }

      if (!hasProjectAccess(projectId, userId)) {
        return res.status(404).json({ error: 'Project not found' });
      }

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

      const pendingTasks = tasksDb
        .getByProject(projectId)
        .filter((task) => task.status === 'pending');

      const started: StartPendingAgentsResponse['started'] = [];
      const skipped: StartPendingAgentsResponse['skipped'] = [];

      for (const task of pendingTasks) {
        if (getRunningAgentForTask(task.id)) {
          skipped.push({ taskId: task.id, reason: 'An agent is already running' });
          continue;
        }

        // First step of the pipeline: planification (or yolo for YOLO tasks).
        // The completion handler then auto-chains the rest.
        const agentType: AgentType = task.yolo_mode ? 'yolo' : 'planification';
        try {
          const { agentRun } = await startAgentRun(task.id, agentType, {
            broadcastFn,
            broadcastToTaskSubscribersFn,
            userId,
          });
          started.push({ taskId: task.id, agentType, agentRunId: agentRun.id });
        } catch (error) {
          // A missing-credentials error is global to the user — surface it as a
          // 403 rather than silently skipping every task.
          if (error instanceof ProviderCredentialsMissingError) {
            throw error;
          }
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`Error starting agent for task ${task.id}:`, msg);
          skipped.push({ taskId: task.id, reason: msg });
        }
      }

      res.status(200).json({ started, skipped });
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
          code: 'PROVIDER_CREDENTIALS_MISSING',
          provider: error.provider,
        } as never);
        return;
      }
      console.error('Error batch-starting pending agents:', error);
      res.status(500).json({ error: 'Failed to start pending agents' });
    }
  },
);

router.get(
  '/agent-runs/:id',
  (req: Request<{ id: string }>, res: Response<GetAgentRunResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const agentRunId = parseInt(req.params.id, 10);

      if (isNaN(agentRunId)) {
        return res.status(400).json({ error: 'Invalid agent run ID' });
      }

      const agentRun = agentRunsDb.getById(agentRunId);
      if (!agentRun) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const taskWithProject = tasksDb.getWithProject(agentRun.task_id);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      res.json(agentRun);
    } catch (error) {
      console.error('Error getting agent run:', error);
      res.status(500).json({ error: 'Failed to get agent run' });
    }
  },
);

router.put(
  '/agent-runs/:id/complete',
  (req: Request<{ id: string }>, res: Response<CompleteAgentRunResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const agentRunId = parseInt(req.params.id, 10);

      if (isNaN(agentRunId)) {
        return res.status(400).json({ error: 'Invalid agent run ID' });
      }

      const agentRun = agentRunsDb.getById(agentRunId);
      if (!agentRun) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const taskWithProject = tasksDb.getWithProject(agentRun.task_id);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const updated = agentRunsDb.updateStatus(agentRunId, 'completed');
      if (!updated) {
        return res.status(404).json({ error: 'Agent run not found' });
      }
      res.json(updated);
    } catch (error) {
      console.error('Error completing agent run:', error);
      res.status(500).json({ error: 'Failed to complete agent run' });
    }
  },
);

router.put(
  '/agent-runs/:id/link-conversation',
  (
    req: Request<{ id: string }, LinkConversationResponse | ApiError, LinkConversationRequest>,
    res: Response<LinkConversationResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const agentRunId = parseInt(req.params.id, 10);
      const { conversationId } = req.body;

      if (isNaN(agentRunId)) {
        return res.status(400).json({ error: 'Invalid agent run ID' });
      }

      if (!conversationId) {
        return res.status(400).json({ error: 'Conversation ID is required' });
      }

      const agentRun = agentRunsDb.getById(agentRunId);
      if (!agentRun) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const taskWithProject = tasksDb.getWithProject(agentRun.task_id);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const updated = agentRunsDb.linkConversation(agentRunId, conversationId);
      if (!updated) {
        return res.status(404).json({ error: 'Agent run not found' });
      }
      res.json(updated);
    } catch (error) {
      console.error('Error linking conversation to agent run:', error);
      res.status(500).json({ error: 'Failed to link conversation' });
    }
  },
);

router.delete(
  '/agent-runs/:id',
  (req: Request<{ id: string }>, res: Response<DeleteAgentRunResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const agentRunId = parseInt(req.params.id, 10);

      if (isNaN(agentRunId)) {
        return res.status(400).json({ error: 'Invalid agent run ID' });
      }

      const agentRun = agentRunsDb.getById(agentRunId);
      if (!agentRun) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const taskWithProject = tasksDb.getWithProject(agentRun.task_id);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      const deleted = agentRunsDb.delete(agentRunId);
      if (!deleted) {
        return res.status(404).json({ error: 'Agent run not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting agent run:', error);
      res.status(500).json({ error: 'Failed to delete agent run' });
    }
  },
);

export default router;
