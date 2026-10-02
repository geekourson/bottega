/**
 * ProjectCardGrid.tsx - Grid-Style Project Card
 *
 * Modern card component for the dashboard grid layout.
 * Shows project name, status badges, and action buttons.
 */

import React, { useState } from 'react';
import { CornerDownRight, Folder, Layers, Pencil, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import StatusBadge from './StatusBadge';
import type { ProjectRow, TaskStatus } from '../../../shared/types/db';

export interface TaskCounts {
  pending: number;
  in_progress: number;
  completed: number;
}

export interface ProjectCardGridProps {
  project: ProjectRow;
  taskCounts?: TaskCounts;
  hasLiveTask?: boolean;
  onCardClick?: () => void;
  onEditClick?: () => void;
  onDeleteClick?: (projectId: number) => void | Promise<unknown>;
  onStatusBadgeClick?: (status: TaskStatus) => void;
  // Multi-repo epics extra: an umbrella lists its children; a child links
  // back to its umbrella. Clicking either navigates to that project's board.
  childProjects?: ProjectRow[];
  parentProject?: ProjectRow | null;
  onProjectNavigate?: (projectId: number) => void;
}

function ProjectCardGrid({
  project,
  taskCounts = { pending: 0, in_progress: 0, completed: 0 },
  hasLiveTask = false,
  onCardClick,
  onEditClick,
  onDeleteClick,
  onStatusBadgeClick,
  childProjects = [],
  parentProject = null,
  onProjectNavigate,
}: ProjectCardGridProps) {
  const isUmbrella = project.is_umbrella === 1;
  const [isDeleting, setIsDeleting] = useState(false);

  const totalTasks = taskCounts.pending + taskCounts.in_progress + taskCounts.completed;
  const hasTasks = totalTasks > 0;

  const handleDelete = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (
      !confirm(
        'Are you sure you want to delete this project? All tasks and conversations will be lost.'
      )
    ) {
      return;
    }
    setIsDeleting(true);
    try {
      await onDeleteClick?.(project.id);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEdit = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onEditClick?.();
  };

  return (
    <div
      data-testid={`project-card-grid-${project.name.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={onCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCardClick?.();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        'group relative rounded-xl border p-4 transition-all duration-200',
        'bg-gradient-to-br from-card to-card/80',
        'hover:shadow-lg hover:shadow-primary/5',
        'hover:border-primary/30',
        'cursor-pointer',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        hasLiveTask
          ? 'border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.15)]'
          : 'border-border'
      )}
    >
      {/* Live indicator */}
      {hasLiveTask && (
        <div className="absolute top-3 right-3">
          <span className="flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
          </span>
        </div>
      )}

      {/* Header: Icon and Name */}
      <div className="flex items-start gap-3 mb-3">
        <div
          className={cn(
            'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
            'bg-primary/10 text-primary',
            'group-hover:bg-primary/15 transition-colors'
          )}
        >
          {isUmbrella ? <Layers className="w-5 h-5" /> : <Folder className="w-5 h-5" />}
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-semibold text-foreground truncate text-base leading-tight">
              {project.name}
            </h3>
            {isUmbrella && (
              <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                Multi-repo
              </span>
            )}
          </div>
          {parentProject && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onProjectNavigate?.(parentProject.id);
              }}
              className="flex items-center gap-1 text-xs text-primary/80 hover:text-primary hover:underline mt-0.5 max-w-full"
              title={`Open umbrella project ${parentProject.name}`}
            >
              <CornerDownRight className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{parentProject.name}</span>
            </button>
          )}
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {project.repo_folder_path}
          </p>
        </div>
      </div>

      {/* Child projects (umbrella only) */}
      {isUmbrella && (
        <div className="flex flex-wrap gap-1.5 mb-3" data-testid="umbrella-children">
          {childProjects.length === 0 ? (
            <span className="text-xs text-muted-foreground italic">No child projects yet</span>
          ) : (
            childProjects.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onProjectNavigate?.(child.id);
                }}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-border bg-muted/50 hover:border-primary/50 hover:text-primary transition-colors"
                title={`Open ${child.name}`}
              >
                <Folder className="w-3 h-3" />
                {child.name}
              </button>
            ))
          )}
        </div>
      )}

      {/* Status Badges */}
      <div className="flex flex-wrap gap-2 mb-3">
        <StatusBadge
          status="pending"
          count={taskCounts.pending}
          onClick={onStatusBadgeClick}
        />
        <StatusBadge
          status="in_progress"
          count={taskCounts.in_progress}
          onClick={onStatusBadgeClick}
        />
        <StatusBadge
          status="completed"
          count={taskCounts.completed}
          onClick={onStatusBadgeClick}
        />
        {!hasTasks && (
          <span className="text-xs text-muted-foreground italic">No tasks yet</span>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-1 pt-2 border-t border-border/50">
        <button
          type="button"
          className={cn(
            'p-2 rounded-lg text-muted-foreground transition-colors',
            'hover:text-primary hover:bg-primary/10',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          onClick={handleEdit}
          title="Edit project"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          type="button"
          className={cn(
            'p-2 rounded-lg text-muted-foreground transition-colors',
            'hover:text-red-500 hover:bg-red-500/10',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          onClick={handleDelete}
          disabled={isDeleting}
          title="Delete project"
        >
          {isDeleting ? (
            <div className="w-4 h-4 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

export default ProjectCardGrid;
