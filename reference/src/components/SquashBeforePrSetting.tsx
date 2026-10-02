/**
 * SquashBeforePrSetting.tsx - project setting "one commit per PR".
 *
 * When on, the PR / YOLO / PR-feedback agents squash the task branch into a
 * single commit before opening the PR (and fold later fixes into it), and the
 * manual "Create PR" button squashes too. Saved immediately on toggle.
 */

import { useEffect, useState } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import { api } from '../utils/api';

export default function SquashBeforePrSetting({ projectId }: { projectId: number }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.projects.getSettings(projectId);
        if (!cancelled && response.ok) setEnabled((await response.json()).squash_before_pr);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggle = async () => {
    if (enabled === null) return;
    const next = !enabled;
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.projects.updateSettings(projectId, { squash_before_pr: next });
      if (!response.ok) {
        setError('Failed to save the setting');
        return;
      }
      setEnabled((await response.json()).squash_before_pr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <label className="flex items-start gap-3 p-3 rounded-md border border-border cursor-pointer hover:bg-accent/50 transition-colors">
      <input
        type="checkbox"
        checked={enabled ?? false}
        disabled={enabled === null || isSaving}
        onChange={() => void toggle()}
        className="mt-0.5"
        data-testid="squash-before-pr"
      />
      <span className="space-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <GitCommitHorizontal className="w-4 h-4 text-muted-foreground" />
          One commit per PR (squash before opening the PR)
        </span>
        <span className="block text-xs text-muted-foreground">
          Agents squash the branch into a single commit before opening the PR, then fold CI fixes and review
          feedback into it (amend + force-push with lease). The Create PR button squashes too.
        </span>
        {error && <span className="block text-xs text-red-600 dark:text-red-400">{error}</span>}
      </span>
    </label>
  );
}
