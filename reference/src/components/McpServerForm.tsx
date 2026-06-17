/**
 * McpServerForm.tsx — modal to add an MCP server to ~/.claude.json.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { AddMcpServerRequest } from '../../shared/api/mcp';

export interface McpServerFormSubmitResult {
  success: boolean;
  error?: string;
}

export interface McpServerFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: AddMcpServerRequest) => Promise<McpServerFormSubmitResult>;
  isSubmitting?: boolean;
}

type Transport = 'stdio' | 'http';

function parseStringRecord(raw: string, label: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`${label} value for "${key}" must be a string`);
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseArgs(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/);
}

function parseEnv(raw: string): Record<string, string> | undefined {
  return parseStringRecord(raw, 'Environment variables');
}

function McpServerForm({ isOpen, onClose, onSubmit, isSubmitting = false }: McpServerFormProps) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envJson, setEnvJson] = useState('');
  const [url, setUrl] = useState('');
  const [headersJson, setHeadersJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setTransport('stdio');
      setCommand('');
      setArgs('');
      setEnvJson('');
      setUrl('');
      setHeadersJson('');
      setError(null);
    }
  }, [isOpen]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Server name is required');
      return;
    }

    let payload: AddMcpServerRequest;
    try {
      if (transport === 'stdio') {
        if (!command.trim()) {
          setError('Command is required for stdio transport');
          return;
        }
        payload = {
          transport: 'stdio',
          name: name.trim(),
          command: command.trim(),
          args: parseArgs(args),
          env: envJson.trim() ? parseEnv(envJson) : undefined,
          scope: 'global',
        };
      } else {
        if (!url.trim()) {
          setError('URL is required for HTTP transport');
          return;
        }
        payload = {
          transport: 'http',
          name: name.trim(),
          url: url.trim(),
          headers: headersJson.trim() ? parseStringRecord(headersJson, 'Headers') : undefined,
          scope: 'global',
        };
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      const result = await onSubmit(payload);
      if (!result.success) {
        setError(result.error || 'Failed to add MCP server');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add MCP server');
    }
  };

  if (!isOpen) return null;

  const selectClass =
    'text-sm w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Add MCP Server</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="mcp-server-form">
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="mcp-name" className="text-sm font-medium text-foreground">
                Name
              </label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="playwright"
                autoFocus
                data-testid="mcp-name-input"
              />
              <p className="text-xs text-muted-foreground">Letters, numbers, hyphens, and underscores.</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="mcp-transport" className="text-sm font-medium text-foreground">
                Transport
              </label>
              <select
                id="mcp-transport"
                value={transport}
                onChange={(e) => setTransport(e.target.value as Transport)}
                className={selectClass}
                data-testid="mcp-transport-select"
              >
                <option value="stdio">stdio (local command)</option>
                <option value="http">HTTP / SSE (remote URL)</option>
              </select>
            </div>

            {transport === 'stdio' ? (
              <>
                <div className="space-y-2">
                  <label htmlFor="mcp-command" className="text-sm font-medium text-foreground">
                    Command
                  </label>
                  <Input
                    id="mcp-command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx"
                    data-testid="mcp-command-input"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="mcp-args" className="text-sm font-medium text-foreground">
                    Arguments <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <Input
                    id="mcp-args"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="-y @playwright/mcp"
                    data-testid="mcp-args-input"
                  />
                  <p className="text-xs text-muted-foreground">Space-separated.</p>
                </div>
                <div className="space-y-2">
                  <label htmlFor="mcp-env" className="text-sm font-medium text-foreground">
                    Environment <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <textarea
                    id="mcp-env"
                    value={envJson}
                    onChange={(e) => setEnvJson(e.target.value)}
                    placeholder='{"API_KEY": "your-key"}'
                    rows={3}
                    className={`${selectClass} font-mono text-xs resize-y`}
                    data-testid="mcp-env-input"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <label htmlFor="mcp-url" className="text-sm font-medium text-foreground">
                    URL
                  </label>
                  <Input
                    id="mcp-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://api.pixellab.ai/mcp"
                    data-testid="mcp-url-input"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="mcp-headers" className="text-sm font-medium text-foreground">
                    Headers <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <textarea
                    id="mcp-headers"
                    value={headersJson}
                    onChange={(e) => setHeadersJson(e.target.value)}
                    placeholder='{"Authorization": "Bearer your-token"}'
                    rows={3}
                    className={`${selectClass} font-mono text-xs resize-y`}
                    data-testid="mcp-headers-input"
                  />
                  <p className="text-xs text-muted-foreground">
                    JSON object for HTTP headers (e.g. <code>Authorization</code>).
                  </p>
                </div>
              </>
            )}

            <p className="text-xs text-muted-foreground">
              Saved to the global <code>mcpServers</code> block in <code>~/.claude.json</code>.
            </p>

            <div className="flex gap-2 pt-2">
              <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={isSubmitting} data-testid="mcp-submit-button">
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                    Adding…
                  </>
                ) : (
                  'Add server'
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default McpServerForm;
