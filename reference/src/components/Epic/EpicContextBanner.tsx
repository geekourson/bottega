/**
 * EpicContextBanner.tsx - shown on a sub-task's detail page (multi-repo epics
 * extra): link back to its epic in the umbrella project, its dependencies,
 * and — when parked — a notice with a "Cancel wait" action.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Hourglass, Layers, X } from 'lucide-react';
import { api } from '../../utils/api';
import { useTaskContext } from '../../contexts/TaskContext';
import type { EpicContextResponse, TaskRef } from '../../../shared/api/epics';
import type { TaskRow } from '../../../shared/types/db';

export interface EpicContextBannerProps {
  task: TaskRow;
}

export default function EpicContextBanner({ task }: EpicContextBannerProps) {
  const navigate = useNavigate();
  const { updateTask } = useTaskContext();
  const [context, setContext] = useState<EpicContextResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.epics.context(task.id);
      if (response.ok) setContext(await response.json());
    } catch (err) {
      console.error('Failed to load epic context:', err);
    }
  }, [task.id]);

  // Reload when this task's flags move (waiting released, status change).
  useEffect(() => {
    void load();
  }, [load, task.waiting_on_dependencies, task.status, task.pr_agent_complete]);

  if (!context || (!context.epic && context.dependsOn.length === 0 && context.dependents.length === 0)) {
    return null;
  }

  const openTask = (ref: TaskRef) => navigate(`/projects/${ref.project.id}/tasks/${ref.id}`);
  const unmet = context.dependsOn.filter((d) => !d.satisfied);

  return (
    <div className="px-4 py-2 border-b border-border bg-primary/5 space-y-1.5 text-xs" data-testid="epic-context-banner">
      {context.epic && (
        <button
          type="button"
          onClick={() => navigate(`/projects/${context.epic!.project.id}/tasks/${context.epic!.id}`)}
          className="flex items-center gap-1.5 text-primary hover:underline max-w-full"
        >
          <Layers className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">
            Sub-task of epic #{context.epic.id} — {context.epic.title || 'Untitled'} ({context.epic.project.name})
          </span>
        </button>
      )}

      {context.dependsOn.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Depends on:</span>
          {context.dependsOn.map((d) => (
            <DependencyChip key={d.id} dep={d} onClick={() => openTask(d)} />
          ))}
        </div>
      )}

      {context.dependents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Blocks:</span>
          {context.dependents.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => openTask(d)}
              className="px-2 py-0.5 rounded-full border border-border bg-card hover:border-primary/50"
            >
              #{d.id} {d.title} · {d.project.name}
            </button>
          ))}
        </div>
      )}

      {task.waiting_on_dependencies === 1 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-800 dark:text-amber-300">
          <Hourglass className="w-3.5 h-3.5 flex-shrink-0 animate-pulse" />
          <span className="flex-1">
            {unmet.length > 0
              ? `Implementation will start automatically once ${unmet.map((d) => `#${d.id}`).join(', ')} ha${unmet.length > 1 ? 've' : 's'} its PR ready.`
              : 'Dependencies are ready — implementation is starting.'}
          </span>
          <button
            type="button"
            onClick={() => void updateTask(task.id, { waiting_on_dependencies: false })}
            className="flex items-center gap-1 hover:underline flex-shrink-0"
            title="Stop waiting; you can still press Run later"
          >
            <X className="w-3 h-3" /> Cancel wait
          </button>
        </div>
      )}
    </div>
  );
}

function DependencyChip({ dep, onClick }: { dep: TaskRef; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        dep.satisfied
          ? 'flex items-center gap-1 px-2 py-0.5 rounded-full border border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400'
          : 'flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
      }
      title={dep.satisfied ? 'PR ready' : 'Not ready yet'}
    >
      {dep.satisfied ? <CheckCircle2 className="w-3 h-3" /> : <Hourglass className="w-3 h-3" />}#{dep.id} {dep.title} · {dep.project.name}
    </button>
  );
}
