// Request/response shapes for the agent-run endpoints:
//  - /api/tasks/:taskId/agent-runs   (list, create)
//  - /api/agent-runs/:id*            (get, complete, link-conversation, delete)

import type { AgentRunRow, AgentType } from '../types/db';
import { expectType } from './_common';

// `AgentType` is the same string-literal union the route validates against
// (see `tasks.js` and `agent-runs.js`'s `validAgentTypes` list — the values
// are kept in sync via the CHECK constraint on `task_agent_runs.agent_type`).

export type ListAgentRunsResponse = AgentRunRow[];

export interface CreateAgentRunRequest {
  agentType: AgentType;
}

export type CreateAgentRunResponse = AgentRunRow;

// `202 Accepted` body when the run was accepted but the local GPU is busy.
// The run is added to the sequential queue and will start automatically.
export interface QueuedAgentRunResponse {
  queued: true;
  taskId: number;
  agentType: AgentType;
  /** 1-based position in the queue. */
  position: number;
}

// `409 Conflict` body when another agent is already running for this task.
export interface AgentRunConflictResponse {
  error: 'An agent is already running for this task';
  runningAgent: AgentRunRow;
}

export type GetAgentRunResponse = AgentRunRow;

// `PUT /api/agent-runs/:id/complete` returns the updated row.
export type CompleteAgentRunResponse = AgentRunRow;

export interface LinkConversationRequest {
  conversationId: number;
}

export type LinkConversationResponse = AgentRunRow;

export interface DeleteAgentRunResponse {
  success: true;
}

// `POST /api/projects/:projectId/agent-runs/start-pending` — batch-start the
// first pipeline agent (planification, or yolo for YOLO tasks) on every
// eligible pending task in a project. Tasks with an agent already running are
// reported under `skipped`. When sequential mode is active (local GPU providers),
// only the first task runs immediately; the rest are reported under `queued`.
export interface StartPendingAgentsResponse {
  started: { taskId: number; agentType: AgentType; agentRunId: number }[];
  queued: { taskId: number; agentType: AgentType }[];
  skipped: { taskId: number; reason: string }[];
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<CreateAgentRunRequest['agentType']>('implementation');
