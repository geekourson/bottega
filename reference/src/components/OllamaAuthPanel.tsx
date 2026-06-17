// Settings → Providers — Ollama connection status + URL configuration.
//
// Ollama needs no API key. The panel shows whether the local Ollama server
// is reachable, lets the user override the default URL (http://localhost:11434),
// and lists the models currently installed on their machine.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Trash2, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { OllamaAuthStatusResponse } from '../../shared/api/ollamaAuth';

const DEFAULT_URL = 'http://localhost:11434';

export function OllamaAuthPanel() {
  const [status, setStatus] = useState<OllamaAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urlValue, setUrlValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.ollamaAuth.status();
      if (!res.ok) {
        setError('Failed to check Ollama status');
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
      const res = await api.ollamaAuth.setUrl(trimmed);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setUrlValue('');
      setInfo('Ollama URL saved. Checking connection…');
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
      const res = await api.ollamaAuth.clear();
      if (!res.ok) {
        setError('Failed to reset Ollama URL');
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

        {status?.authenticated && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={submitting}
            data-testid="ollama-auth-clear"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Reset to default URL
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="ollama-url"
          className="block text-sm font-medium text-foreground"
        >
          Ollama base URL{' '}
          <span className="text-muted-foreground font-normal">
            (default: {DEFAULT_URL})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="ollama-url"
            type="url"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            autoComplete="off"
            placeholder={status?.url ?? DEFAULT_URL}
            disabled={submitting}
            data-testid="ollama-url-input"
            className="flex-1 font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button
            onClick={handleSaveUrl}
            disabled={submitting}
            data-testid="ollama-url-save"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            {status?.authenticated ? 'Update URL' : 'Connect'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave blank to use the default URL, or enter a custom address if Ollama runs on a different port or host.
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
