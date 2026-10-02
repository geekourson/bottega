/**
 * EpicPanel.tsx - the epic page's main panel (multi-repo epics extra,
 * extra/multi-repo-epics.md).
 *
 * Before approval: the breakdown proposed by the breakdown agent, grouped by
 * child project, with "Approve & create sub-tasks".
 * After approval: every sub-task across every child project — status, live
 * indicator, dependency wait — each one a link to the sub-task in its child
 * project; each group header a link to the child's board.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Folder,
  GitBranch,
  Hourglass,
  Layers,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { api } from '../../utils/api';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useTaskContext } from '../../contexts/TaskContext';
import { useTasksLiveSubscriptions } from '../../hooks/useTasksLiveSubscriptions';
import TaskStatusPill from './TaskStatusPill';
import type { EpicOverviewResponse, EpicSubtask, ProjectRef } from '../../../shared/api/epics';
import type { BreakdownSubtask } from '../../../shared/schemas/epics';
import type { TaskRow } from '../../../shared/types/db';

export interface EpicPanelProps {
  epic: TaskRow;
  isBreakdownRunning: boolean;
  className?: string;
}

function groupByProject<T>(items: T[], projectOf: (item: T) => ProjectRef, order: ProjectRef[]) {
  const groups = new Map<number, { project: ProjectRef; items: T[] }>();
  for (const p of order) groups.set(p.id, { project: p, items: [] });
  for (const item of items) {
    const project = projectOf(item);
    if (!groups.has(project.id)) groups.set(project.id, { project, items: [] });
    groups.get(project.id)!.items.push(item);
  }
  return [...groups.values()].filter((g) => g.items.length > 0);
}

function excerpt(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function EpicPanel({ epic, isBreakdownRunning, className }: EpicPanelProps) {
  const navigate = useNavigate();
  const { subscribe, unsubscribe } = useWebSocket();
  const { isTaskLive, liveTaskIds } = useTaskContext();
  void liveTaskIds; // re-render on live changes (isTaskLive reads a ref)

  const [overview, setOverview] = useState<EpicOverviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startPlanning, setStartPlanning] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [planningErrors, setPlanningErrors] = useState<Array<{ taskId: number; error: string }>>([]);

  const load = useCallback(async () => {
    try {
      const response = await api.epics.get(epic.id);
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        setLoadError(err.error || 'Failed to load the epic');
        return;
      }
      setOverview(await response.json());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [epic.id]);

  // Reload when the epic's own flags move (breakdown completed / approved).
  useEffect(() => {
    void load();
  }, [load, epic.planification_complete, epic.breakdown_approved, epic.status, isBreakdownRunning]);

  const subtaskIds = useMemo(() => overview?.subtasks.map((s) => s.task.id) ?? [], [overview]);
  useTasksLiveSubscriptions(subtaskIds);

  // Any event on a sub-task (agent progress, status/flag change) → refetch.
  useEffect(() => {
    if (!subscribe || !unsubscribe || subtaskIds.length === 0) return;
    const ids = new Set(subtaskIds);
    const onTaskEvent = (message: { taskId?: number }) => {
      if (typeof message.taskId === 'number' && ids.has(message.taskId)) void load();
    };
    subscribe('agent-run-updated', onTaskEvent);
    subscribe('task-updated', onTaskEvent);
    subscribe('task-blocked', onTaskEvent);
    return () => {
      unsubscribe('agent-run-updated', onTaskEvent);
      unsubscribe('task-updated', onTaskEvent);
      unsubscribe('task-blocked', onTaskEvent);
    };
  }, [subscribe, unsubscribe, subtaskIds, load]);

  const handleApprove = async () => {
    setIsApproving(true);
    setApproveError(null);
    try {
      const response = await api.epics.approveBreakdown(epic.id, startPlanning);
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        setApproveError(err.error || 'Failed to approve the breakdown');
        return;
      }
      const result = await response.json();
      setPlanningErrors(result.planningErrors);
      await load();
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsApproving(false);
    }
  };

  const openTask = (task: TaskRow) => navigate(`/projects/${task.project_id}/tasks/${task.id}`);
  const openProject = (projectId: number) => navigate(`/projects/${projectId}`);

  if (loadError) {
    return (
      <div className={cn('p-4 border-t border-border text-sm text-red-600 dark:text-red-400 flex items-center gap-2', className)}>
        <AlertCircle className="w-4 h-4" /> {loadError}
      </div>
    );
  }
  if (!overview) {
    return (
      <div className={cn('p-4 border-t border-border', className)}>
        <div className="h-16 bg-muted rounded-lg animate-pulse" />
      </div>
    );
  }

  const approved = overview.epic.breakdown_approved === 1;

  return (
    <div className={cn('p-4 border-t border-border space-y-3 min-w-0', className)} data-testid="epic-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
          <Layers className="w-4 h-4 text-primary" />
          {approved ? 'Sub-tasks across repositories' : 'Proposed breakdown'}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="h-7 w-7 p-0" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {overview.childProjects.length === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 rounded-md p-2">
          This umbrella has no child projects yet. Attach the repositories from the umbrella&apos;s board
          (Child projects → Manage) before running the breakdown agent.
        </p>
      )}

      {approved ? (
        <ApprovedView
          overview={overview}
          isTaskLive={isTaskLive}
          onOpenTask={openTask}
          onOpenProject={openProject}
          planningErrors={planningErrors}
        />
      ) : overview.breakdown ? (
        <>
          <p className="text-sm text-muted-foreground">{overview.breakdown.summary}</p>
          {overview.breakdown.sharedContract.trim() && (
            <details className="rounded-md border border-border bg-muted/30">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Shared contract</summary>
              <pre className="px-3 pb-3 text-xs whitespace-pre-wrap break-words font-mono text-muted-foreground">
                {overview.breakdown.sharedContract}
              </pre>
            </details>
          )}
          <ProposedView
            subtasks={overview.breakdown.subtasks}
            projects={overview.childProjects}
            onOpenProject={openProject}
          />

          {approveError && (
            <div className="p-2 rounded-md bg-red-500/10 text-xs text-red-700 dark:text-red-300">{approveError}</div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={startPlanning} onChange={(e) => setStartPlanning(e.target.checked)} />
              Start planning on every sub-task
            </label>
            <Button
              size="sm"
              className="sm:ml-auto gap-2"
              onClick={() => void handleApprove()}
              disabled={isApproving || isBreakdownRunning || overview.epic.planification_complete !== 1}
              data-testid="approve-breakdown"
            >
              {isApproving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Approve &amp; create {overview.breakdown.subtasks.length} sub-task
              {overview.breakdown.subtasks.length > 1 ? 's' : ''}
            </Button>
          </div>
          {overview.epic.planification_complete !== 1 && (
            <p className="text-xs text-muted-foreground">
              Waiting for the breakdown agent to validate its breakdown (complete-breakdown.ts).
            </p>
          )}
        </>
      ) : (
        <EmptyBreakdown
          errors={overview.breakdownErrors}
          hasRun={overview.epic.planification_complete === 1 || isBreakdownRunning}
          isRunning={isBreakdownRunning}
        />
      )}
    </div>
  );
}

function EmptyBreakdown({ errors, hasRun, isRunning }: { errors: string[]; hasRun: boolean; isRunning: boolean }) {
  if (isRunning) {
    return (
      <p className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> The breakdown agent is exploring the child repositories…
      </p>
    );
  }
  const missing = errors.length === 1 && errors[0]!.startsWith('breakdown file not found');
  if (!hasRun || missing) {
    return (
      <p className="text-sm text-muted-foreground">
        Run the <span className="font-medium text-foreground">Breakdown</span> agent below: it reads every child
        repository and proposes sub-tasks for you to approve.
      </p>
    );
  }
  return (
    <div className="p-2 rounded-md bg-red-500/10 text-xs text-red-700 dark:text-red-300 space-y-1">
      <p className="font-medium">The breakdown file is invalid — ask the breakdown agent to fix it:</p>
      <ul className="list-disc pl-4">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

function ProposedView({
  subtasks,
  projects,
  onOpenProject,
}: {
  subtasks: BreakdownSubtask[];
  projects: ProjectRef[];
  onOpenProject: (id: number) => void;
}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const titleByKey = new Map(subtasks.map((s) => [s.key, s.title]));
  const groups = groupByProject(
    subtasks,
    (s) => byId.get(s.projectId) ?? { id: s.projectId, name: `Project #${s.projectId}` },
    projects,
  );

  return (
    <div className="space-y-3">
      {groups.map(({ project, items }) => (
        <div key={project.id} className="rounded-lg border border-border overflow-hidden">
          <ProjectHeader project={project} count={items.length} onOpen={() => onOpenProject(project.id)} />
          <ul className="divide-y divide-border">
            {items.map((s) => (
              <li key={s.key} className="px-3 py-2 space-y-1">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-xs text-muted-foreground">{excerpt(s.description)}</p>
                {s.dependsOn.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
                    <Hourglass className="w-3 h-3" />
                    After: {s.dependsOn.map((k) => titleByKey.get(k) ?? k).join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ApprovedView({
  overview,
  isTaskLive,
  onOpenTask,
  onOpenProject,
  planningErrors,
}: {
  overview: EpicOverviewResponse;
  isTaskLive: (id: number) => boolean;
  onOpenTask: (task: TaskRow) => void;
  onOpenProject: (id: number) => void;
  planningErrors: Array<{ taskId: number; error: string }>;
}) {
  const total = overview.subtasks.length;
  const done = overview.subtasks.filter((s) => s.task.status === 'completed').length;
  const ready = overview.subtasks.filter((s) => s.task.pr_agent_complete === 1 && s.task.status !== 'completed').length;
  const groups = groupByProject<EpicSubtask>(overview.subtasks, (s) => s.project, overview.childProjects);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {done}/{total} completed{ready > 0 ? ` · ${ready} PR${ready > 1 ? 's' : ''} ready` : ''}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all"
            style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
          />
        </div>
      </div>

      {planningErrors.length > 0 && (
        <div className="p-2 rounded-md bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300">
          Planning could not start on {planningErrors.map((e) => `#${e.taskId}`).join(', ')}: {planningErrors[0]!.error}
        </div>
      )}

      {groups.map(({ project, items }) => (
        <div key={project.id} className="rounded-lg border border-border overflow-hidden">
          <ProjectHeader project={project} count={items.length} onOpen={() => onOpenProject(project.id)} />
          <ul className="divide-y divide-border">
            {items.map(({ task, dependsOn }) => {
              const unmet = dependsOn.filter((d) => !d.satisfied);
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => onOpenTask(task)}
                    className="w-full text-left px-3 py-2 hover:bg-accent/50 transition-colors flex items-center gap-2 min-w-0"
                    data-testid={`epic-subtask-${task.id}`}
                  >
                    {isTaskLive(task.id) && (
                      <span className="relative flex h-2 w-2 flex-shrink-0" title="Agent running">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">
                        <span className="text-muted-foreground font-normal">#{task.id}</span> {task.title}
                      </span>
                      {dependsOn.length > 0 && (
                        <span
                          className={cn(
                            'flex items-center gap-1 text-xs',
                            unmet.length > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400',
                          )}
                        >
                          {unmet.length > 0 ? <Hourglass className="w-3 h-3" /> : <GitBranch className="w-3 h-3" />}
                          {task.waiting_on_dependencies === 1 ? 'Waiting on ' : 'After '}
                          {dependsOn.map((d) => `#${d.id}`).join(', ')}
                        </span>
                      )}
                    </span>
                    {task.pr_agent_complete === 1 && task.status !== 'completed' && (
                      <span className="text-xs text-blue-600 dark:text-blue-400 flex-shrink-0">PR ready</span>
                    )}
                    <TaskStatusPill status={task.status} className="flex-shrink-0" />
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ProjectHeader({ project, count, onOpen }: { project: ProjectRef; count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/50 hover:bg-muted text-xs font-medium transition-colors"
      title={`Open ${project.name}'s board`}
    >
      <Folder className="w-3.5 h-3.5 text-primary" />
      {project.name}
      <span className="text-muted-foreground font-normal">
        · {count} sub-task{count > 1 ? 's' : ''}
      </span>
      <ArrowRight className="w-3 h-3 ml-auto text-muted-foreground" />
    </button>
  );
}
