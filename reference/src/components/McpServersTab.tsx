/**
 * McpServersTab.tsx — Settings → MCP.
 *
 * Lists the MCP servers configured in ~/.claude.json and lets the user run a
 * live connection probe (connected / failed / needs-auth + tool count) without
 * opening a conversation.
 */

import { useEffect, useState } from 'react';
import {
  Plug,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  RefreshCw,
  Terminal,
  Globe,
  Plus,
} from 'lucide-react';
import { Button } from './ui/button';
import { api } from '../utils/api';
import McpServerForm from './McpServerForm';
import type { AddMcpServerRequest, McpConfiguredServer, McpProbeResult } from '../../shared/api/mcp';

function StatusBadge({
  result,
  isTesting,
}: {
  result: McpProbeResult | undefined;
  isTesting?: boolean;
}) {
  if (isTesting) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Testing…
      </span>
    );
  }
  if (!result) return null;
  const { status } = result;
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    connected: {
      label: 'Connected',
      cls: 'text-emerald-600 dark:text-emerald-400',
      icon: <CheckCircle2 className="w-4 h-4" />,
    },
    failed: {
      label: 'Failed',
      cls: 'text-red-600 dark:text-red-400',
      icon: <XCircle className="w-4 h-4" />,
    },
    'needs-auth': {
      label: 'Needs auth',
      cls: 'text-amber-600 dark:text-amber-400',
      icon: <AlertCircle className="w-4 h-4" />,
    },
    pending: {
      label: 'Pending',
      cls: 'text-muted-foreground',
      icon: <Loader2 className="w-4 h-4 animate-spin" />,
    },
    disabled: {
      label: 'Disabled',
      cls: 'text-muted-foreground',
      icon: <XCircle className="w-4 h-4" />,
    },
    unknown: {
      label: 'Timed out',
      cls: 'text-amber-600 dark:text-amber-400',
      icon: <AlertCircle className="w-4 h-4" />,
    },
  };
  const entry = map[status] ?? {
    label: status || 'No response',
    cls: 'text-muted-foreground',
    icon: <AlertCircle className="w-4 h-4" />,
  };
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${entry.cls}`}>
      {entry.icon}
      {entry.label}
      {typeof result.toolCount === 'number' && result.status === 'connected' && (
        <span className="text-muted-foreground font-normal">· {result.toolCount} tools</span>
      )}
    </span>
  );
}

export function McpServersTab() {
  const [servers, setServers] = useState<McpConfiguredServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isTesting, setIsTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, McpProbeResult>>({});
  const [testSummary, setTestSummary] = useState<string | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const loadServers = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await api.mcp.listServers();
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Failed to load MCP servers');
      }
      const data = await response.json();
      setServers(data.servers);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadServers();
  }, []);

  const handleAddServer = async (payload: AddMcpServerRequest) => {
    setIsAdding(true);
    try {
      const response = await api.mcp.addServer(payload);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return {
          success: false,
          error: (err as { error?: string }).error || 'Failed to add MCP server',
        };
      }
      const data = await response.json();
      setServers((prev) =>
        [...prev.filter((s) => s.name !== data.server.name), data.server].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setResults((prev) => {
        const next = { ...prev };
        delete next[data.server.name];
        return next;
      });
      setIsFormOpen(false);
      return { success: true };
    } finally {
      setIsAdding(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestError(null);
    setTestSummary(null);
    setResults(
      Object.fromEntries(servers.map((s) => [s.name, { name: s.name, status: 'pending' as const }])),
    );
    try {
      const response = await api.mcp.test();
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'MCP probe failed');
      }
      const data = await response.json();
      const byName: Record<string, McpProbeResult> = {};
      for (const r of data.results) byName[r.name] = r;
      setResults(byName);

      const connected = data.results.filter((r) => r.status === 'connected').length;
      const failed = data.results.filter((r) => r.status === 'failed').length;
      const other = data.results.length - connected - failed;
      const parts: string[] = [];
      if (connected > 0) parts.push(`${connected} connected`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (other > 0) parts.push(`${other} other`);
      setTestSummary(parts.length > 0 ? `Test complete: ${parts.join(', ')}` : 'Test complete');
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
      setResults({});
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="mcp-servers-tab">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Plug className="w-5 h-5 text-blue-500" /> MCP Servers
          </h3>
          <p className="text-sm text-muted-foreground">
            Configured in <code>~/.claude.json</code> (global <code>mcpServers</code> and
            per-project entries). Add servers here or edit the file directly, then re-test.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsFormOpen(true)}
            data-testid="mcp-add-button"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Add
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void loadServers()} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            onClick={() => void handleTest()}
            disabled={isTesting || servers.length === 0}
            data-testid="mcp-test-button"
          >
            {isTesting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Plug className="w-4 h-4 mr-1.5" />}
            {isTesting ? 'Testing…' : 'Test connections'}
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{loadError}</span>
        </div>
      )}
      {testError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{testError}</span>
        </div>
      )}
      {testSummary && !testError && (
        <div
          className={`p-3 rounded text-sm border ${
            testSummary.includes('failed') || testSummary.includes('other')
              ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300'
              : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {testSummary}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : servers.length === 0 ? (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-6 text-center">
          No MCP servers configured. Click <strong>Add</strong> to create one, or edit
          <code className="ml-1">~/.claude.json</code> and refresh.
        </div>
      ) : (
        <ul className="space-y-2" data-testid="mcp-server-list">
          {servers.map((server) => {
            const result = results[server.name];
            return (
              <li
                key={server.name}
                data-testid={`mcp-server-${server.name}`}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-card"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate">{server.name}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {server.transport === 'http' ? (
                        <Globe className="w-3 h-3" />
                      ) : (
                        <Terminal className="w-3 h-3" />
                      )}
                      {server.transport}
                    </span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {server.scope}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {server.url || server.command || '—'}
                  </p>
                  {result?.error && (
                    <p className="text-xs text-red-600 dark:text-red-400 truncate" title={result.error}>
                      {result.error}
                    </p>
                  )}
                </div>
                <div className="flex-shrink-0">
                  <StatusBadge result={result} isTesting={isTesting} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Testing launches a short-lived Claude session to connect each server, so
        it needs a connected Claude subscription. Servers run in each task's git
        worktree — prefer the global <code>mcpServers</code> block so they apply
        everywhere.
      </p>

      <McpServerForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSubmit={handleAddServer}
        isSubmitting={isAdding}
      />
    </div>
  );
}

export default McpServersTab;
