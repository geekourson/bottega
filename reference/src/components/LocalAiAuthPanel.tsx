// Settings → Providers — Local AI server connection status + URL configuration.
//
// "Local AI" covers any local inference server with an Anthropic-compatible API:
// llama-server (llama.cpp), LM Studio, Jan.ai, etc. No API key required.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Trash2, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { LocalAiAuthStatusResponse } from '../../shared/api/localAiAuth';

const DEFAULT_URL = 'http://localhost:8080';

export function LocalAiAuthPanel() {
  const [status, setStatus] = useState<LocalAiAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urlValue, setUrlValue] = useState('');
  const [maxTokensValue, setMaxTokensValue] = useState('');
  const [contextWindowValue, setContextWindowValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.localAiAuth.status();
      if (!res.ok) {
        setError('Failed to check Local AI status');
        setStatus(null);
        return;
      }
      const body = await res.json();
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveUrl = async (): Promise<void> => {
    const trimmed = urlValue.trim() || DEFAULT_URL;
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.localAiAuth.setUrl(trimmed);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setUrlValue('');
      setInfo('Local AI URL saved. Checking connection…');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

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
      const res = await api.localAiAuth.setMaxTokens(tokens);
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
      const res = await api.localAiAuth.setContextWindow(tokens);
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

  const handleClear = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.localAiAuth.clear();
      if (!res.ok) {
        setError('Failed to reset Local AI URL');
        return;
      }
      const body = await res.json();
      setInfo(body.cleared ? `URL reset to ${DEFAULT_URL}.` : 'Nothing to reset.');
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="local-ai-auth-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Local AI (llama-server / LM Studio / Jan)</h3>
        <p className="text-sm text-muted-foreground">
          Run any local model via an Anthropic-compatible server:{' '}
          <a
            href="https://github.com/ggml-org/llama.cpp"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline"
          >
            llama-server
          </a>
          ,{' '}
          <a
            href="https://lmstudio.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline"
          >
            LM Studio
          </a>
          ,{' '}
          <a
            href="https://jan.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline"
          >
            Jan
          </a>
          , and others. No API key required — Bottega connects to your local server.
        </p>
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm" data-testid="local-ai-auth-row">
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Checking Local AI server…</span>
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

        {status?.authenticated && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={submitting}
            data-testid="local-ai-auth-clear"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Reset to default URL
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="local-ai-url"
          className="block text-sm font-medium text-foreground"
        >
          Server base URL{' '}
          <span className="text-muted-foreground font-normal">
            (default: {DEFAULT_URL})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="local-ai-url"
            type="url"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            autoComplete="off"
            placeholder={status?.url ?? DEFAULT_URL}
            disabled={submitting}
            data-testid="local-ai-url-input"
            className="flex-1 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleSaveUrl}
            disabled={submitting}
            data-testid="local-ai-url-save"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            {status?.authenticated ? 'Update URL' : 'Connect'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Default port is 8080 (llama-server), 1234 (LM Studio), or 1337 (Jan). Enter the
          base URL without a path.
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="local-ai-max-tokens"
          className="block text-sm font-medium text-foreground"
        >
          Max output tokens{' '}
          <span className="text-muted-foreground font-normal">
            (current: {status?.maxOutputTokens?.toLocaleString() ?? '64,000'})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="local-ai-max-tokens"
            type="number"
            min={1000}
            step={1000}
            value={maxTokensValue}
            onChange={(e) => setMaxTokensValue(e.target.value)}
            placeholder={String(status?.maxOutputTokens ?? 64000)}
            disabled={submitting}
            data-testid="local-ai-max-tokens-input"
            className="w-40 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleSaveMaxTokens}
            disabled={submitting || !maxTokensValue.trim()}
            data-testid="local-ai-max-tokens-save"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Increase if your local model hits the output limit. Must match or be below your
          server's configured generation limit.
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="local-ai-context-window"
          className="block text-sm font-medium text-foreground"
        >
          Context window{' '}
          <span className="text-muted-foreground font-normal">
            (current: {status?.contextWindowTokens?.toLocaleString() ?? '8,192'})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="local-ai-context-window"
            type="number"
            min={1000}
            step={1000}
            value={contextWindowValue}
            onChange={(e) => setContextWindowValue(e.target.value)}
            placeholder={String(status?.contextWindowTokens ?? 8192)}
            disabled={submitting}
            data-testid="local-ai-context-window-input"
            className="w-40 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleSaveContextWindow}
            disabled={submitting || !contextWindowValue.trim()}
            data-testid="local-ai-context-window-save"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Must match the context size your server is actually configured with. Bottega trims
          old conversation history on resume to stay under this limit — set it too high and
          you'll see "exceeds the available context size" errors again.
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

export default LocalAiAuthPanel;
