/**
 * BreakdownEditor.tsx - human edit of a proposed epic breakdown before
 * approval (multi-repo epics extra). Saves through PUT /api/tasks/:id/breakdown,
 * which applies the same validation as complete-breakdown.ts.
 */

import { useState } from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { api } from '../../utils/api';
import type { EpicOverviewResponse, ProjectRef } from '../../../shared/api/epics';
import type { Breakdown, BreakdownSubtask } from '../../../shared/schemas/epics';

export interface BreakdownEditorProps {
  epicId: number;
  breakdown: Breakdown;
  projects: ProjectRef[];
  onSaved: (overview: EpicOverviewResponse) => void;
  onCancel: () => void;
}

const textareaClass =
  'w-full min-h-[120px] p-2 bg-background border border-input rounded-md text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring';

/** Mirrors the server default (`task/<id>-<title-slug>`); the id is only known once created. */
function defaultBranchHint(title: string): string {
  const slug = (title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return `task/<id>-${slug}`;
}

function newKey(existing: BreakdownSubtask[]): string {
  const keys = new Set(existing.map((s) => s.key));
  let n = existing.length + 1;
  while (keys.has(`subtask-${n}`)) n += 1;
  return `subtask-${n}`;
}

export default function BreakdownEditor({ epicId, breakdown, projects, onSaved, onCancel }: BreakdownEditorProps) {
  const [draft, setDraft] = useState<Breakdown>(() => structuredClone(breakdown));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateSubtask = (key: string, patch: Partial<BreakdownSubtask>) =>
    setDraft((d) => ({ ...d, subtasks: d.subtasks.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));

  const removeSubtask = (key: string) =>
    setDraft((d) => ({
      ...d,
      subtasks: d.subtasks
        .filter((s) => s.key !== key)
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((k) => k !== key) })),
    }));

  const addSubtask = () =>
    setDraft((d) => ({
      ...d,
      subtasks: [
        ...d.subtasks,
        { key: newKey(d.subtasks), projectId: projects[0]?.id ?? 0, title: '', description: '', dependsOn: [] },
      ],
    }));

  const toggleDependency = (key: string, dep: string) => {
    const subtask = draft.subtasks.find((s) => s.key === key);
    if (!subtask) return;
    updateSubtask(key, {
      dependsOn: subtask.dependsOn.includes(dep)
        ? subtask.dependsOn.filter((k) => k !== dep)
        : [...subtask.dependsOn, dep],
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      // Empty overrides mean "use the default" — don't send them at all.
      const payload: Breakdown = {
        ...draft,
        subtasks: draft.subtasks.map(({ branch, prTitle, ...rest }) => ({
          ...rest,
          ...(branch?.trim() ? { branch: branch.trim() } : {}),
          ...(prTitle?.trim() ? { prTitle: prTitle.trim() } : {}),
        })),
      };
      const response = await api.epics.saveBreakdown(epicId, payload);
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string; issues?: Array<{ path: unknown[]; message: string }> };
        const issues = err.issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        setError(issues || err.error || 'Failed to save the breakdown');
        return;
      }
      onSaved(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="breakdown-editor">
      <label className="block space-y-1">
        <span className="text-xs font-medium">Summary</span>
        <textarea
          className={textareaClass.replace('min-h-[120px]', 'min-h-[60px]')}
          value={draft.summary}
          onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium">Shared contract (markdown)</span>
        <textarea
          className={textareaClass}
          value={draft.sharedContract}
          onChange={(e) => setDraft((d) => ({ ...d, sharedContract: e.target.value }))}
        />
      </label>

      <div className="space-y-3">
        <span className="text-xs font-medium">Sub-tasks</span>
        {draft.subtasks.map((s, index) => {
          const others = draft.subtasks.filter((o) => o.key !== s.key);
          return (
            <div key={s.key} className="rounded-lg border border-border p-3 space-y-2" data-testid={`edit-subtask-${index}`}>
              <div className="flex gap-2">
                <Input
                  value={s.title}
                  placeholder="Title"
                  onChange={(e) => updateSubtask(s.key, { title: e.target.value })}
                  aria-label={`Title of sub-task ${index + 1}`}
                />
                <select
                  value={s.projectId}
                  onChange={(e) => updateSubtask(s.key, { projectId: Number(e.target.value) })}
                  className="h-10 px-2 bg-background border border-input rounded-md text-sm"
                  aria-label={`Repository of sub-task ${index + 1}`}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSubtask(s.key)}
                  className="h-10 w-10 p-0 text-muted-foreground hover:text-red-500"
                  title="Remove this sub-task"
                  disabled={draft.subtasks.length === 1}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  value={s.branch ?? ''}
                  placeholder={defaultBranchHint(s.title)}
                  onChange={(e) => updateSubtask(s.key, { branch: e.target.value })}
                  aria-label={`Branch of sub-task ${index + 1}`}
                  className="font-mono text-xs"
                />
                <Input
                  value={s.prTitle ?? ''}
                  placeholder="PR title (chosen by the PR agent if empty)"
                  onChange={(e) => updateSubtask(s.key, { prTitle: e.target.value })}
                  aria-label={`PR title of sub-task ${index + 1}`}
                />
              </div>
              <textarea
                className={textareaClass}
                value={s.description}
                placeholder="What to build in this repository (markdown)"
                onChange={(e) => updateSubtask(s.key, { description: e.target.value })}
                aria-label={`Description of sub-task ${index + 1}`}
              />
              {others.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Depends on:</span>
                  {others.map((o) => (
                    <label key={o.key} className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={s.dependsOn.includes(o.key)}
                        onChange={() => toggleDependency(s.key, o.key)}
                      />
                      {o.title || o.key}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <Button variant="outline" size="sm" onClick={addSubtask} className="gap-2" disabled={projects.length === 0}>
          <Plus className="w-4 h-4" /> Add sub-task
        </Button>
      </div>

      {error && <div className="p-2 rounded-md bg-red-500/10 text-xs text-red-700 dark:text-red-300">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={isSaving} className="gap-2" data-testid="save-breakdown">
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save breakdown
        </Button>
      </div>
    </div>
  );
}
