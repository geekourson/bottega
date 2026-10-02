/**
 * Multi-repo epics extra (extra/multi-repo-epics.md).
 *
 * An umbrella project groups child projects (one repo each). An epic is a task
 * in an umbrella; its `breakdown` agent writes a breakdown JSON next to the
 * epic doc. Approving it creates ordinary core tasks ("sub-tasks") in the
 * child projects, linked to the epic and to each other by dependencies.
 *
 * This module owns everything that is not plain CRUD:
 *  - breakdown validation (shared with scripts/complete-breakdown.ts),
 *  - approval (topological creation, doc seeding, all-or-nothing rollback),
 *  - dependency gating + the scheduler (`releaseDependents`),
 *  - epic status derivation (`syncEpicStatus`),
 *  - the read models behind the epic page and the sub-task banner.
 *
 * `agentRunner` is imported dynamically: agentRunner → startConversation →
 * agentRunLifecycle → this module would otherwise be a load-time cycle.
 */

import fs from 'fs';
import path from 'path';
import { epicsDb, projectsDb, tasksDb } from '../database/db.js';
import type { ProjectRow, TaskRow, TaskWithProject } from '../database/db.js';
import {
  deleteTaskArchive,
  getEpicBreakdownPath,
  getTaskDocPath,
  writeTaskDoc,
} from './documentation.js';
import { createWorktree, isGitRepository, removeWorktree } from './worktree.js';
import { BreakdownSchema, type Breakdown, type BreakdownSubtask } from '../../shared/schemas/epics.js';
import type {
  EpicContextResponse,
  EpicOverviewResponse,
  ProjectRef,
  TaskRef,
} from '../../shared/api/epics.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
} from '../../shared/websocket/messages.js';

/** Error carrying the HTTP status the route should answer with. */
export class EpicError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EpicError';
  }
}

export interface EpicBroadcastOptions {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function isEpic(task: Pick<TaskWithProject, 'project_is_umbrella'>): boolean {
  return task.project_is_umbrella === 1;
}

function projectRef(project: Pick<ProjectRow, 'id' | 'name'> | undefined, fallbackId: number): ProjectRef {
  return { id: project?.id ?? fallbackId, name: project?.name ?? `Project #${fallbackId}` };
}

/**
 * A dependency is ready once its PR is open with green CI (the PR agent ran
 * complete-pr.ts) or the task was completed by hand.
 */
export function isDependencySatisfied(task: Pick<TaskRow, 'pr_agent_complete' | 'status'>): boolean {
  return task.pr_agent_complete === 1 || task.status === 'completed';
}

export function toTaskRef(task: TaskRow): TaskRef {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    project: projectRef(projectsDb.getByIdAdmin(task.project_id), task.project_id),
    satisfied: isDependencySatisfied(task),
  };
}

export function getUnmetDependencies(taskId: number): TaskRow[] {
  return epicsDb.getDependencies(taskId).filter((dep) => !isDependencySatisfied(dep));
}

function broadcastTaskUpdated(task: TaskRow | null | undefined, opts: EpicBroadcastOptions): void {
  if (!task || !opts.broadcastToTaskSubscribersFn) return;
  opts.broadcastToTaskSubscribersFn(task.id, { type: 'task-updated', task });
}

// ---------------------------------------------------------------------------
// Breakdown validation
// ---------------------------------------------------------------------------

/**
 * Topological order of the sub-tasks (dependencies first), stable with respect
 * to the file order. Returns null when the dependency graph has a cycle.
 * Assumes keys are unique and every dependsOn entry names an existing key.
 */
export function topologicalOrder(subtasks: readonly BreakdownSubtask[]): BreakdownSubtask[] | null {
  const byKey = new Map(subtasks.map((s) => [s.key, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const ordered: BreakdownSubtask[] = [];

  const visit = (key: string): boolean => {
    const current = state.get(key);
    if (current === 'done') return true;
    if (current === 'visiting') return false;
    state.set(key, 'visiting');
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!visit(dep)) return false;
    }
    state.set(key, 'done');
    ordered.push(byKey.get(key)!);
    return true;
  };

  for (const subtask of subtasks) {
    if (!visit(subtask.key)) return null;
  }
  return ordered;
}

/**
 * Semantic checks the zod schema can't express. `childProjectIds` are the
 * umbrella's current children — the only valid targets.
 */
export function validateBreakdownSemantics(
  breakdown: Breakdown,
  childProjectIds: ReadonlySet<number>,
): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();

  for (const subtask of breakdown.subtasks) {
    if (keys.has(subtask.key)) errors.push(`duplicate key "${subtask.key}"`);
    keys.add(subtask.key);
    if (!childProjectIds.has(subtask.projectId)) {
      errors.push(
        `sub-task "${subtask.key}": projectId ${subtask.projectId} is not a child project of this umbrella` +
          ` (valid: ${[...childProjectIds].join(', ') || 'none'})`,
      );
    }
  }

  const branchesByProject = new Map<number, Set<string>>();
  for (const subtask of breakdown.subtasks) {
    if (!subtask.branch) continue;
    const branches = branchesByProject.get(subtask.projectId) ?? new Set<string>();
    if (branches.has(subtask.branch)) {
      errors.push(`sub-task "${subtask.key}": branch "${subtask.branch}" is used twice in the same repository`);
    }
    branches.add(subtask.branch);
    branchesByProject.set(subtask.projectId, branches);
  }

  for (const subtask of breakdown.subtasks) {
    for (const dep of subtask.dependsOn) {
      if (dep === subtask.key) errors.push(`sub-task "${subtask.key}" depends on itself`);
      else if (!keys.has(dep)) errors.push(`sub-task "${subtask.key}" depends on unknown key "${dep}"`);
    }
  }

  if (errors.length === 0 && topologicalOrder(breakdown.subtasks) === null) {
    errors.push('the dependencies form a cycle');
  }
  return errors;
}

export interface ParsedBreakdown {
  breakdown: Breakdown | null;
  errors: string[];
}

/** Parse + validate a breakdown from raw JSON text. */
export function parseBreakdown(raw: string, childProjectIds: ReadonlySet<number>): ParsedBreakdown {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { breakdown: null, errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = BreakdownSchema.safeParse(json);
  if (!result.success) {
    return {
      breakdown: null,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const errors = validateBreakdownSemantics(result.data, childProjectIds);
  return errors.length > 0 ? { breakdown: null, errors } : { breakdown: result.data, errors: [] };
}

/** Read and validate the epic's breakdown file. */
export function readEpicBreakdown(epic: Pick<TaskRow, 'id' | 'project_id'>): ParsedBreakdown {
  const breakdownPath = getEpicBreakdownPath(epic.project_id, epic.id);
  if (!fs.existsSync(breakdownPath)) {
    return { breakdown: null, errors: [`breakdown file not found: ${breakdownPath}`] };
  }
  const childIds = new Set(epicsDb.getChildProjects(epic.project_id).map((p) => p.id));
  return parseBreakdown(fs.readFileSync(breakdownPath, 'utf8'), childIds);
}

/**
 * Human edit of a proposed breakdown (before approval). Same validation as
 * complete-breakdown.ts; a valid breakdown saved by a human counts as ready
 * for approval (sets planification_complete).
 */
export async function saveEpicBreakdown(epicId: number, raw: unknown): Promise<Breakdown> {
  const epic = tasksDb.getWithProject(epicId);
  if (!epic) throw new EpicError(404, 'Task not found');
  if (!isEpic(epic)) throw new EpicError(400, 'This task is not an epic');
  if (epic.breakdown_approved === 1) {
    throw new EpicError(409, 'The breakdown was already approved — edit the sub-tasks in their projects');
  }
  const { getRunningAgentForTask } = await import('./agentRunner.js');
  if (getRunningAgentForTask(epicId)) {
    throw new EpicError(409, 'The breakdown agent is running — wait for it to finish before editing');
  }

  const childIds = new Set(epicsDb.getChildProjects(epic.project_id).map((p) => p.id));
  const { breakdown, errors } = parseBreakdown(JSON.stringify(raw), childIds);
  if (!breakdown) throw new EpicError(422, `Invalid breakdown: ${errors.join('; ')}`);

  const breakdownPath = getEpicBreakdownPath(epic.project_id, epicId);
  fs.mkdirSync(path.dirname(breakdownPath), { recursive: true });
  fs.writeFileSync(breakdownPath, `${JSON.stringify(breakdown, null, 2)}\n`, 'utf8');
  if (epic.planification_complete !== 1) tasksDb.update(epicId, { planification_complete: 1 });
  return breakdown;
}

// ---------------------------------------------------------------------------
// Umbrella wiring
// ---------------------------------------------------------------------------

/**
 * Replace an umbrella's children. Enforces the one-level invariants: the
 * target is an umbrella, children are not umbrellas, and a child already
 * attached to another umbrella must be detached there first.
 */
export function setChildProjects(umbrellaId: number, userId: number, childIds: readonly number[]): ProjectRow[] {
  const umbrella = projectsDb.getById(umbrellaId, userId);
  if (!umbrella) throw new EpicError(404, 'Project not found');
  if (umbrella.is_umbrella !== 1) throw new EpicError(400, 'Only an umbrella project can have child projects');

  const unique = [...new Set(childIds)];
  for (const childId of unique) {
    const child = projectsDb.getById(childId, userId);
    if (!child) throw new EpicError(400, `Project ${childId} not found`);
    if (child.is_umbrella === 1) throw new EpicError(400, `"${child.name}" is an umbrella project and cannot be a child`);
    if (child.parent_project_id !== null && child.parent_project_id !== umbrellaId) {
      // An orphan (parent gone or no longer an umbrella) is free to re-attach.
      const currentParent = projectsDb.getByIdAdmin(child.parent_project_id);
      if (currentParent?.is_umbrella === 1) {
        throw new EpicError(409, `"${child.name}" already belongs to another umbrella project`);
      }
    }
  }

  epicsDb.setChildProjects(umbrellaId, unique);
  return epicsDb.getChildProjects(umbrellaId);
}

// ---------------------------------------------------------------------------
// Approval — create the sub-tasks
// ---------------------------------------------------------------------------

interface CreatedSubtask {
  task: TaskRow;
  project: ProjectRow;
  branch: string | null;
  worktreeCreated: boolean;
}

export function buildSubtaskDoc(params: {
  subtask: BreakdownSubtask;
  epic: Pick<TaskRow, 'id' | 'title'>;
  umbrellaName: string;
  epicDocPath: string;
  sharedContract: string;
  dependencies: Array<{ taskId: number; title: string; projectName: string; branch: string | null }>;
}): string {
  const { subtask, epic, umbrellaName, epicDocPath, sharedContract, dependencies } = params;
  const epicLabel = epic.title || `Epic ${epic.id}`;

  const contract = sharedContract.trim() || '_No shared contract for this epic._';
  const deps =
    dependencies.length === 0
      ? '_None — this sub-task can be implemented independently._'
      : dependencies
          .map(
            (d) =>
              `- Task #${d.taskId} — ${d.title} (${d.projectName})` +
              (d.branch ? `, branch \`${d.branch}\`` : '') +
              '. Implementation here starts automatically once its PR is open with green CI;' +
              ' pull that branch if you need its code.',
          )
          .join('\n');

  return `# ${subtask.title}

> **Sub-task of epic #${epic.id} — ${epicLabel}** (umbrella project "${umbrellaName}").
> This repository is one of several touched by the epic. The epic doc — overview and
> full breakdown across repositories — is at \`${epicDocPath}\`. Read it for the
> cross-repo picture, but only build what is described below, in this repository.

## What to build here

${subtask.description.trim()}

## Shared contract

Shared by every sub-task of the epic, across repositories. Implement your side of it
exactly; do not change it unilaterally.

${contract}

## Dependencies

${deps}
`;
}

async function rollbackSubtasks(created: CreatedSubtask[]): Promise<void> {
  for (const item of [...created].reverse()) {
    try {
      if (item.worktreeCreated) {
        const result = await removeWorktree(item.project.repo_folder_path, item.task.id);
        if (!result.success) {
          console.error(`[Epics] Rollback: failed to remove worktree for task ${item.task.id}:`, result.error);
        }
      }
      tasksDb.delete(item.task.id);
      deleteTaskArchive(item.project.id, item.task.id);
    } catch (err) {
      console.error(`[Epics] Rollback of task ${item.task.id} failed:`, err);
    }
  }
}

export interface ApproveBreakdownResult {
  epic: TaskRow;
  subtasks: TaskRow[];
  planningErrors: Array<{ taskId: number; error: string }>;
}

/**
 * Create every sub-task of an approved breakdown, all-or-nothing, in
 * topological order (so a dependent's doc can name its dependencies' branches).
 */
export async function approveBreakdown(
  epicId: number,
  userId: number,
  options: EpicBroadcastOptions & { startPlanning?: boolean | undefined } = {},
): Promise<ApproveBreakdownResult> {
  const epic = tasksDb.getWithProject(epicId);
  if (!epic) throw new EpicError(404, 'Task not found');
  if (!isEpic(epic)) throw new EpicError(400, 'This task is not an epic (its project is not an umbrella)');
  if (epic.breakdown_approved === 1) throw new EpicError(409, 'The breakdown was already approved');
  if (epic.planification_complete !== 1) {
    throw new EpicError(409, 'The breakdown agent has not completed yet (complete-breakdown.ts not run)');
  }

  const { getRunningAgentForTask } = await import('./agentRunner.js');
  if (getRunningAgentForTask(epicId)) throw new EpicError(409, 'An agent is still running on this epic');

  const { breakdown, errors } = readEpicBreakdown(epic);
  if (!breakdown) throw new EpicError(422, `Invalid breakdown: ${errors.join('; ')}`);

  const ordered = topologicalOrder(breakdown.subtasks)!;
  const epicDocPath = getTaskDocPath(epic.project_id, epicId);
  const created: CreatedSubtask[] = [];
  const createdByKey = new Map<string, CreatedSubtask>();

  try {
    for (const subtask of ordered) {
      const project = projectsDb.getByIdAdmin(subtask.projectId);
      if (!project) throw new Error(`Project ${subtask.projectId} no longer exists`);

      // Same rules as core task-create: decide isolation once, create the
      // worktree, keep the flag in sync with what exists on disk.
      const isGit = await isGitRepository(project.repo_folder_path);
      const row = tasksDb.create(project.id, subtask.title, false, userId, false, isGit);
      const entry: CreatedSubtask = {
        task: tasksDb.getById(row.id)!,
        project,
        branch: null,
        worktreeCreated: false,
      };
      created.push(entry);

      if (isGit) {
        const result = await createWorktree(
          project.repo_folder_path,
          row.id,
          subtask.title,
          project.subproject_path,
          subtask.branch || null,
        );
        if (!result.success) {
          throw new Error(`could not create the worktree for "${subtask.title}" in ${project.name}: ${result.error}`);
        }
        entry.worktreeCreated = true;
        entry.branch = result.branch ?? null;
      }

      tasksDb.update(row.id, { parent_task_id: epicId, pr_title: subtask.prTitle || null });

      const dependencies = subtask.dependsOn.map((key) => {
        const dep = createdByKey.get(key)!;
        epicsDb.addDependency(row.id, dep.task.id);
        return {
          taskId: dep.task.id,
          title: dep.task.title || `Task ${dep.task.id}`,
          projectName: dep.project.name,
          branch: dep.branch,
        };
      });

      writeTaskDoc(
        project.id,
        row.id,
        buildSubtaskDoc({
          subtask,
          epic,
          umbrellaName: epic.project_name,
          epicDocPath,
          sharedContract: breakdown.sharedContract,
          dependencies,
        }),
      );

      entry.task = tasksDb.getById(row.id)!;
      createdByKey.set(subtask.key, entry);
    }
  } catch (err) {
    await rollbackSubtasks(created);
    const message = err instanceof Error ? err.message : String(err);
    throw new EpicError(500, `Failed to create the sub-tasks (nothing was kept): ${message}`);
  }

  const updatedEpic = tasksDb.update(epicId, {
    breakdown_approved: 1,
    ...(epic.status === 'pending' || epic.status === 'completed' ? { status: 'in_progress' as const } : {}),
  })!;
  broadcastTaskUpdated(updatedEpic, options);

  const planningErrors: ApproveBreakdownResult['planningErrors'] = [];
  if (options.startPlanning) {
    const { startAgentRun } = await import('./agentRunner.js');
    for (const item of created) {
      try {
        await startAgentRun(item.task.id, 'planification', {
          broadcastFn: options.broadcastFn,
          broadcastToTaskSubscribersFn: options.broadcastToTaskSubscribersFn,
          userId,
        });
      } catch (err) {
        planningErrors.push({ taskId: item.task.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    epic: updatedEpic,
    subtasks: created.map((c) => tasksDb.getById(c.task.id)!),
    planningErrors,
  };
}

// ---------------------------------------------------------------------------
// Dependency gating + scheduler
// ---------------------------------------------------------------------------

/** The agent a waiting task runs once released: its code-work entry point. */
export function codeEntryAgent(task: Pick<TaskRow, 'yolo_mode'>): 'yolo' | 'implementation' {
  return task.yolo_mode === 1 ? 'yolo' : 'implementation';
}

/**
 * Park a task until its dependencies are ready. Returns the unmet
 * dependencies, or an empty array when the task may start now.
 */
export function holdIfDependenciesUnmet(taskId: number, opts: EpicBroadcastOptions = {}): TaskRow[] {
  const unmet = getUnmetDependencies(taskId);
  if (unmet.length > 0) {
    const updated = epicsDb.setWaitingOnDependencies(taskId, true);
    broadcastTaskUpdated(updated, opts);
  }
  return unmet;
}

/**
 * The scheduler: called whenever `taskId` may have just become a satisfied
 * dependency. Starts every waiting dependent whose dependencies are now all
 * ready. Never throws — a dependent that fails to start stays released and
 * can be re-run by hand.
 */
export async function releaseDependents(taskId: number, opts: EpicBroadcastOptions = {}): Promise<number[]> {
  const task = tasksDb.getById(taskId);
  if (!task || !isDependencySatisfied(task)) return [];

  const started: number[] = [];
  const { startAgentRun, getRunningAgentForTask } = await import('./agentRunner.js');

  for (const dependent of epicsDb.getDependents(taskId)) {
    if (dependent.waiting_on_dependencies !== 1) continue;
    if (getUnmetDependencies(dependent.id).length > 0) continue;
    if (getRunningAgentForTask(dependent.id)) continue;

    const released = epicsDb.setWaitingOnDependencies(dependent.id, false);
    broadcastTaskUpdated(released, opts);

    const agentType = codeEntryAgent(dependent);
    console.log(`[Epics] Dependencies of task ${dependent.id} are ready — starting ${agentType}`);
    try {
      await startAgentRun(dependent.id, agentType, {
        broadcastFn: opts.broadcastFn,
        broadcastToTaskSubscribersFn: opts.broadcastToTaskSubscribersFn,
        userId: dependent.user_id ?? undefined,
      });
      started.push(dependent.id);
    } catch (err) {
      console.error(`[Epics] Failed to start ${agentType} on released task ${dependent.id}:`, err);
    }
  }
  return started;
}

// ---------------------------------------------------------------------------
// Epic status
// ---------------------------------------------------------------------------

/**
 * Derive the epic's status from its sub-tasks: completed when they all are,
 * back to in_progress when one of them is reopened. Returns the updated epic,
 * or null when nothing changed.
 */
export function syncEpicStatus(epicId: number, opts: EpicBroadcastOptions = {}): TaskRow | null {
  const epic = tasksDb.getById(epicId);
  if (!epic || epic.breakdown_approved !== 1) return null;
  const subtasks = epicsDb.getSubtasks(epicId);
  if (subtasks.length === 0) return null;

  const allDone = subtasks.every((t) => t.status === 'completed');
  let next: TaskRow['status'] | null = null;
  if (allDone && epic.status !== 'completed') next = 'completed';
  else if (!allDone && (epic.status === 'completed' || epic.status === 'pending')) next = 'in_progress';
  if (!next) return null;

  const updated = tasksDb.update(epicId, { status: next }) ?? null;
  broadcastTaskUpdated(updated, opts);
  return updated;
}

/** Run the post-transition hooks for a task that may have become "ready" or "completed". */
export async function onSubtaskProgress(taskId: number, opts: EpicBroadcastOptions = {}): Promise<void> {
  try {
    await releaseDependents(taskId, opts);
    const task = tasksDb.getById(taskId);
    if (task?.parent_task_id) syncEpicStatus(task.parent_task_id, opts);
  } catch (err) {
    console.error(`[Epics] Post-progress hooks failed for task ${taskId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export function getEpicOverview(epicId: number): EpicOverviewResponse {
  const epic = tasksDb.getWithProject(epicId);
  if (!epic) throw new EpicError(404, 'Task not found');
  if (!isEpic(epic)) throw new EpicError(400, 'This task is not an epic');

  const umbrella = projectsDb.getByIdAdmin(epic.project_id);
  const children = epicsDb.getChildProjects(epic.project_id);
  const { breakdown, errors } = readEpicBreakdown(epic);

  const subtasks = epicsDb.getSubtasks(epicId).map((task) => ({
    task,
    project: projectRef(projectsDb.getByIdAdmin(task.project_id), task.project_id),
    dependsOn: epicsDb.getDependencies(task.id).map(toTaskRef),
  }));

  return {
    epic: tasksDb.getById(epicId)!,
    umbrella: projectRef(umbrella, epic.project_id),
    childProjects: children.map((p) => projectRef(p, p.id)),
    breakdown,
    breakdownErrors: breakdown ? [] : errors,
    subtasks,
  };
}

export function getEpicContext(taskId: number): EpicContextResponse {
  const task = tasksDb.getById(taskId);
  if (!task) throw new EpicError(404, 'Task not found');

  const parent = task.parent_task_id ? tasksDb.getById(task.parent_task_id) : undefined;
  return {
    epic: parent
      ? {
          id: parent.id,
          title: parent.title,
          project: projectRef(projectsDb.getByIdAdmin(parent.project_id), parent.project_id),
        }
      : null,
    dependsOn: epicsDb.getDependencies(taskId).map(toTaskRef),
    dependents: epicsDb.getDependents(taskId).map(toTaskRef),
  };
}
