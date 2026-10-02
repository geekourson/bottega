/**
 * ChildProjectsModal.tsx - attach/detach the child projects of an umbrella
 * (multi-repo epics extra). Lists every visible project that is neither an
 * umbrella nor attached to another umbrella; saving replaces the full list.
 */

import { useEffect, useMemo, useState } from 'react';
import { Folder, Layers, X } from 'lucide-react';
import { Button } from '../ui/button';
import { api } from '../../utils/api';
import type { ProjectRow } from '../../../shared/types/db';

export interface ChildProjectsModalProps {
  isOpen: boolean;
  umbrella: ProjectRow;
  projects: ProjectRow[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export default function ChildProjectsModal({ isOpen, umbrella, projects, onClose, onSaved }: ChildProjectsModalProps) {
  const candidates = useMemo(() => {
    // A parent that is no longer in the list (e.g. a deleted umbrella) does
    // not hold its former children.
    const umbrellaIds = new Set(projects.filter((p) => p.is_umbrella === 1).map((p) => p.id));
    return projects
      .filter(
        (p) =>
          p.id !== umbrella.id &&
          p.is_umbrella !== 1 &&
          (p.parent_project_id == null ||
            p.parent_project_id === umbrella.id ||
            !umbrellaIds.has(p.parent_project_id)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, umbrella.id]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set(projects.filter((p) => p.parent_project_id === umbrella.id).map((p) => p.id)));
    setError(null);
  }, [isOpen, projects, umbrella.id]);

  if (!isOpen) return null;

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.projects.setChildren(umbrella.id, [...selected]);
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        setError(err.error || 'Failed to update child projects');
        return;
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-md mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">Child projects</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Pick the repositories that belong to <span className="font-medium text-foreground">{umbrella.name}</span>.
            The breakdown agent reads them and can create sub-tasks in them.
          </p>

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No eligible project. Create one project per repository first (umbrella projects and projects
              already attached to another umbrella are not listed).
            </p>
          ) : (
            <ul className="space-y-1.5" data-testid="child-projects-list">
              {candidates.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-3 p-2 rounded-md border border-border hover:bg-accent/50 cursor-pointer">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{p.name}</span>
                      <span className="block text-xs text-muted-foreground truncate">{p.repo_folder_path}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2 p-4 border-t border-border">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button className="flex-1" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
