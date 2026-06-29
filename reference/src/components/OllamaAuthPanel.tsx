// Settings → Providers — Ollama connection status + URL configuration.
//
// Ollama needs no API key. The panel shows whether the local Ollama server
// is reachable, lets the user override the default URL (http://localhost:11434),
// and lists the models currently installed on their machine.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Trash2, RefreshCw, Plus, Pencil, Check, X } from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { OllamaAuthStatusResponse } from '../../shared/api/ollamaAuth';

export function OllamaAuthPanel() {
  const [status, setStatus] = useState<OllamaAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [maxTokensValue, setMaxTokensValue] = useState('');
  const [contextWindowValue, setContextWindowValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [instances, setInstances] = useState<{ url: string }[]>([]);
  const [newInstanceUrl, setNewInstanceUrl] = useState('');
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, instancesRes] = await Promise.all([
        api.ollamaAuth.status(),
        api.ollamaAuth.instances(),
      ]);
      if (!statusRes.ok) {
        setError('Failed to check Ollama status');
        setStatus(null);
        return;
      }
      const body = await statusRes.json();
      setStatus(body);
      if (instancesRes.ok) {
        const instancesBody = await instancesRes.json() as { instances: { url: string }[] };
        setInstances(instancesBody.instances);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveMaxTokens = async (): Promise<void> => {
    const tokens = parseInt(maxTokensValue.trim(), 10);
    if (!Number.isFinite(tokens) || tokens < 1000) {
      setError('Max output tokens must be a number ≥ 1000');
      return;
    }
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.ollamaAuth.setMaxTokens(tokens);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setMaxTokensValue('');
      setInfo(`Max output tokens set to ${tokens.toLocaleString()}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveContextWindow = async (): Promise<void> => {
    const tokens = parseInt(contextWindowValue.trim(), 10);
    if (!Number.isFinite(tokens) || tokens < 1000) {
      setError('Context window must be a number ≥ 1000');
      return;
    }
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.ollamaAuth.setContextWindow(tokens);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setContextWindowValue('');
      setInfo(`Context window set to ${tokens.toLocaleString()}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddInstance = async (): Promise<void> => {
    const url = newInstanceUrl.trim();
    if (!url) return;
    setInstancesLoading(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.ollamaAuth.addInstance(url);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to add instance');
        return;
      }
      const body = await res.json() as { instances: { url: string }[] };
      setInstances(body.instances);
      setNewInstanceUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstancesLoading(false);
    }
  };

  const handleDeleteInstance = async (url: string): Promise<void> => {
    setInstancesLoading(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.ollamaAuth.deleteInstance(url);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to remove instance');
        return;
      }
      const body = await res.json() as { instances: { url: string }[] };
      setInstances(body.instances);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstancesLoading(false);
    }
  };

  const handleSaveEdit = async (): Promise<void> => {
    if (!editingUrl) return;
    const newUrl = editingValue.trim();
    if (!newUrl || newUrl === editingUrl) { setEditingUrl(null); return; }
    setInstancesLoading(true);
    setError(null);
    setInfo(null);
    try {
      const delRes = await api.ollamaAuth.deleteInstance(editingUrl);
      if (!delRes.ok) {
        const body = (await delRes.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to update instance');
        return;
      }
      const addRes = await api.ollamaAuth.addInstance(newUrl);
      if (!addRes.ok) {
        const body = (await addRes.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Failed to update instance');
        return;
      }
      const body = await addRes.json() as { instances: { url: string }[] };
      setInstances(body.instances);
      setEditingUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstancesLoading(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="ollama-auth-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Ollama (local models)</h3>
        <p className="text-sm text-muted-foreground">
          Run models locally via{' '}
          <a
            href="https://ollama.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline"
          >
            Ollama
          </a>
          . No API key required — Bottega connects to your local Ollama server.
          Install Ollama, run{' '}
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
            ollama pull llama3.2
          </code>{' '}
          (or any model), and connect below.
        </p>
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm" data-testid="ollama-auth-row">
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Checking Ollama…</span>
              </>
            ) : status?.authenticated ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span className="font-medium">Connected</span>
                <code className="text-muted-foreground text-xs">{status.url}</code>
              </>
            ) : (
              <>
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <span>Not reachable</span>
                {status?.reason && (
                  <span className="text-muted-foreground text-xs">— {status.reason}</span>
                )}
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading || submitting}
            title="Re-check connection"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

      </div>

      <div className="space-y-2">
        <label
          htmlFor="ollama-max-tokens"
          className="block text-sm font-medium text-foreground"
        >
          Max output tokens{' '}
          <span className="text-muted-foreground font-normal">
            (current: {status?.maxOutputTokens?.toLocaleString() ?? '64,000'})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="ollama-max-tokens"
            type="number"
            min={1000}
            step={1000}
            value={maxTokensValue}
            onChange={(e) => setMaxTokensValue(e.target.value)}
            placeholder={String(status?.maxOutputTokens ?? 64000)}
            disabled={submitting}
            data-testid="ollama-max-tokens-input"
            className="w-40 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleSaveMaxTokens}
            disabled={submitting || !maxTokensValue.trim()}
            data-testid="ollama-max-tokens-save"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Increase if Ollama models hit the output limit. Higher values use more GPU memory.
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="ollama-context-window"
          className="block text-sm font-medium text-foreground"
        >
          Context window{' '}
          <span className="text-muted-foreground font-normal">
            (current: {status?.contextWindowTokens?.toLocaleString() ?? '8,192'})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="ollama-context-window"
            type="number"
            min={1000}
            step={1000}
            value={contextWindowValue}
            onChange={(e) => setContextWindowValue(e.target.value)}
            placeholder={String(status?.contextWindowTokens ?? 8192)}
            disabled={submitting}
            data-testid="ollama-context-window-input"
            className="w-40 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleSaveContextWindow}
            disabled={submitting || !contextWindowValue.trim()}
            data-testid="ollama-context-window-save"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Must match the context size Ollama is actually configured with (its{' '}
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">num_ctx</code>). Bottega
          trims old conversation history on resume to stay under this limit — set it too high and
          you'll see "exceeds the available context size" errors again.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">
            Instances{' '}
            <span className="text-muted-foreground font-normal">
              ({instances.length} — {instances.length} agent{instances.length > 1 ? 's' : ''} simultané{instances.length > 1 ? 's' : ''})
            </span>
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Chaque instance est un serveur Ollama distinct. Bottega répartit les agents en
          round-robin — N instances = N agents simultanés autorisés.
        </p>
        <div className="space-y-1">
          {instances.map((inst) => (
            <div
              key={inst.url}
              className="flex items-center gap-2 px-3 py-1.5 bg-background border border-border rounded text-xs font-mono"
            >
              {editingUrl === inst.url ? (
                <>
                  <input
                    type="url"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveEdit(); if (e.key === 'Escape') setEditingUrl(null); }}
                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-foreground"
                    autoFocus
                  />
                  <button onClick={() => void handleSaveEdit()} disabled={instancesLoading} title="Confirm" className="text-emerald-500 hover:text-emerald-400 disabled:opacity-30 flex-shrink-0">
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditingUrl(null)} title="Cancel" className="text-muted-foreground hover:text-foreground flex-shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 text-foreground truncate">{inst.url}</span>
                  <button
                    onClick={() => { setEditingUrl(inst.url); setEditingValue(inst.url); }}
                    disabled={instancesLoading}
                    title="Edit"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30 flex-shrink-0"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => void handleDeleteInstance(inst.url)}
                    disabled={instancesLoading}
                    title="Remove"
                    className="text-muted-foreground hover:text-red-500 disabled:opacity-30 flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={newInstanceUrl}
            onChange={(e) => setNewInstanceUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddInstance(); }}
            placeholder="http://localhost:11434"
            disabled={instancesLoading}
            className="flex-1 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleAddInstance}
            disabled={instancesLoading || !newInstanceUrl.trim()}
            size="sm"
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> Ajouter
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Port par défaut : 11434. Pour plusieurs GPUs, lance une instance Ollama par GPU.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {info && !error && (
        <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300">
          {info}
        </div>
      )}
    </div>
  );
}

export default OllamaAuthPanel;
