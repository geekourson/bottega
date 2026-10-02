// Request/response shapes for the multi-repo epics extra
// (extra/multi-repo-epics.md):
//  - GET  /api/tasks/:id/epic               (epic overview)
//  - POST /api/tasks/:id/breakdown/approve  (create the sub-tasks)
//  - GET  /api/tasks/:id/epic-context       (a sub-task's epic + dependencies)
//  - PUT  /api/projects/:id/children        (wire an umbrella's children)

import type { ProjectRow, TaskRow, TaskStatus } from '../types/db';
import type { Breakdown } from '../schemas/epics';

/** Minimal project identity shown next to a task. */
export interface ProjectRef {
  id: number;
  name: string;
}

/** A task reference used in dependency lists. */
export interface TaskRef {
  id: number;
  title: string | null;
  status: TaskStatus;
  project: ProjectRef;
  /** The dependency is ready (PR open + CI green, or task completed). */
  satisfied: boolean;
}

export interface EpicSubtask {
  task: TaskRow;
  project: ProjectRef;
  dependsOn: TaskRef[];
}

export interface EpicOverviewResponse {
  epic: TaskRow;
  umbrella: ProjectRef;
  childProjects: ProjectRef[];
  /** Parsed + validated breakdown, or null when absent/invalid. */
  breakdown: Breakdown | null;
  /** Why the breakdown file is unusable (missing, invalid JSON, schema issues). */
  breakdownErrors: string[];
  subtasks: EpicSubtask[];
}

export interface ApproveBreakdownResponse {
  epic: TaskRow;
  subtasks: TaskRow[];
  /** Sub-tasks whose planning could not be started (when startPlanning was set). */
  planningErrors: Array<{ taskId: number; error: string }>;
}

export interface EpicContextResponse {
  epic: { id: number; title: string | null; project: ProjectRef } | null;
  dependsOn: TaskRef[];
  dependents: TaskRef[];
}

export type SetChildProjectsResponse = ProjectRow[];

/** 202 body of POST /tasks/:id/agent-runs when dependencies are not ready. */
export interface WaitingOnDependenciesResponse {
  waiting: true;
  taskId: number;
  waitingOn: TaskRef[];
}
