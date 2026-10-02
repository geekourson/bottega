/**
 * ChildProjectsStrip.tsx - the umbrella board's "children strip" (multi-repo
 * epics extra): one chip per child project with its task counts. Clicking a
 * chip opens the child's board — the parent → child navigation.
 */

import { useEffect, useState } from 'react';
import { Folder, Settings2 } from 'lucide-react';
import { api } from '../../utils/api';
import type { ProjectRow } from '../../../shared/types/db';

interface Counts {
  open: number;
  completed: number;
}

export interface ChildProjectsStripProps {
  childProjects: ProjectRow[];
  onOpenProject: (projectId: number) => void;
  onManage: () => void;
}

export default function ChildProjectsStrip({ childProjects, onOpenProject, onManage }: ChildProjectsStripProps) {
  const [counts, setCounts] = useState<Record<number, Counts>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      childProjects.map(async (child) => {
        try {
          const response = await api.tasks.list(child.id);
          if (!response.ok) return null;
          const tasks = await response.json();
          const completed = tasks.filter((t) => t.status === 'completed').length;
          return [child.id, { open: tasks.length - completed, completed }] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<number, Counts> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      setCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [childProjects]);

  return (
    <div className="flex items-center gap-2 mt-3 overflow-x-auto scrollbar-hide" data-testid="child-projects-strip">
      <span className="text-xs font-medium text-muted-foreground flex-shrink-0">Child projects:</span>
      {childProjects.length === 0 && (
        <span className="text-xs text-muted-foreground italic flex-shrink-0">none yet</span>
      )}
      {childProjects.map((child) => {
        const c = counts[child.id];
        return (
          <button
            key={child.id}
            type="button"
            onClick={() => onOpenProject(child.id)}
            className="flex items-center gap-1.5 flex-shrink-0 text-xs px-2.5 py-1 rounded-full border border-border bg-card hover:border-primary/50 hover:text-primary transition-colors"
            title={`Open ${child.name}`}
          >
            <Folder className="w-3.5 h-3.5" />
            <span className="font-medium">{child.name}</span>
            {c && (
              <span className="text-muted-foreground">
                {c.open} open · {c.completed} done
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onManage}
        className="flex items-center gap-1 flex-shrink-0 text-xs px-2 py-1 rounded-full text-muted-foreground hover:text-primary transition-colors"
        title="Attach or detach child projects"
        data-testid="manage-child-projects"
      >
        <Settings2 className="w-3.5 h-3.5" />
        Manage
      </button>
    </div>
  );
}
