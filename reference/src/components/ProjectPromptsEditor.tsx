/**
 * ProjectPromptsEditor.tsx — Tier 2 per-project agent prompt overrides.
 *
 * Lets a project fully replace an agent prompt. Resolution at render time is
 * project override → user-global override → bundled default, so this editor
 * only ever writes the project layer. A prominent warning explains the risk of
 * breaking the agent workflow (e.g. dropping the completion-script call).
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { api } from '../utils/api';
import type {
  GetProjectPromptResponse,
  ProjectPromptListItem,
} from '../../shared/api/projects';

interface ProjectPromptsEditorProps {
  projectId: number;
}

function ProjectPromptsEditor({ projectId }: ProjectPromptsEditorProps) {
  const [prompts, setPrompts] = useState<ProjectPromptListItem[]>([]);
  const [selectedName, setSelectedName] = useState<string>('');
  const [detail, setDetail] = useState<GetProjectPromptResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const response = await api.projects.listPrompts(projectId);
      if (response.ok) {
        const data = await response.json();
        setPrompts(data);
        if (data.length > 0 && !selectedName) {
          setSelectedName(data[0]!.name);
        }
      }
    } catch (err) {
      console.error('Error listing project prompts:', err);
    }
    // selectedName intentionally excluded: we only seed it once on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (name: string) => {
    if (!name) return;
    setError(null);
    setStatus(null);
    try {
      const response = await api.projects.getPrompt(projectId, name);
      if (response.ok) {
        const data = await response.json();
        setDetail(data);
        // Seed the editor with the project override if present, else the
        // effective content (so the user starts from what actually runs).
        setDraft(data.projectContent ?? data.effectiveContent);
      }
    } catch (err) {
      console.error('Error loading project prompt:', err);
    }
  }, [projectId]);

  useEffect(() => {
    void loadDetail(selectedName);
  }, [selectedName, loadDetail]);

  const handleSave = useCallback(async () => {
    if (!detail) return;
    setIsBusy(true);
    setError(null);
    setStatus(null);
    try {
      const response = await api.projects.savePrompt(
        projectId,
        detail.name,
        draft,
        detail.mtime ?? undefined,
      );
      if (!response.ok) {
        const data = (await response.json()) as {
          error?: string;
          unknownVariables?: string[];
        };
        const detailMsg = data.unknownVariables?.length
          ? `${data.error}: ${data.unknownVariables.join(', ')}`
          : data.error || 'Failed to save prompt override';
        setError(detailMsg);
        return;
      }
      setStatus('Override saved.');
      await loadDetail(detail.name);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prompt override');
    } finally {
      setIsBusy(false);
    }
  }, [detail, draft, projectId, loadDetail, loadList]);

  const handleReset = useCallback(async () => {
    if (!detail) return;
    setIsBusy(true);
    setError(null);
    setStatus(null);
    try {
      const response = await api.projects.deletePrompt(projectId, detail.name);
      if (!response.ok && response.status !== 204) {
        setError('Failed to reset prompt override');
        return;
      }
      setStatus('Reverted to global/default.');
      await loadDetail(detail.name);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset prompt override');
    } finally {
      setIsBusy(false);
    }
  }, [detail, projectId, loadDetail, loadList]);

  const source = detail?.hasProjectOverride
    ? 'project override'
    : detail?.hasGlobalOverride
      ? 'global override'
      : 'bundled default';

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Overriding a prompt replaces the entire agent instruction for this project only.
          Keep the workflow contract intact — e.g. the completion-script call and status
          markers — or the agent loop may never terminate. Only the listed{' '}
          <code className="text-xs">{'{{variables}}'}</code> may be used.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={selectedName}
          onChange={(e) => setSelectedName(e.target.value)}
          className="h-9 px-3 appearance-none bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
          data-testid="project-prompt-select"
        >
          {prompts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label}
              {p.hasProjectOverride ? ' • overridden' : ''}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">Active source: {source}</span>
      </div>

      {detail && (
        <>
          <p className="text-xs text-muted-foreground">
            Allowed variables:{' '}
            {detail.variables.length
              ? detail.variables.map((v) => `{{${v}}}`).join(', ')
              : 'none'}
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-80 p-3 font-mono text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            data-testid="project-prompt-textarea"
          />

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {status && <p className="text-sm text-green-600 dark:text-green-400">{status}</p>}

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={isBusy} data-testid="project-prompt-save">
              Save override
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={isBusy || !detail.hasProjectOverride}
              data-testid="project-prompt-reset"
            >
              Reset to global/default
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export default ProjectPromptsEditor;
