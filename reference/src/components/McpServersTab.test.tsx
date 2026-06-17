import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import McpServersTab from './McpServersTab';
import { api } from '../utils/api';
import { mockTypedResponse } from '../test/typedResponse';

vi.mock('../utils/api', () => ({
  api: {
    mcp: {
      listServers: vi.fn(),
      addServer: vi.fn(),
      test: vi.fn(),
    },
  },
}));

vi.mock('lucide-react', () => ({
  Plug: () => <span data-testid="icon-plug" />,
  CheckCircle2: () => <span data-testid="icon-check" />,
  XCircle: () => <span data-testid="icon-x" />,
  Loader2: () => <span data-testid="icon-loader" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Terminal: () => <span data-testid="icon-terminal" />,
  Globe: () => <span data-testid="icon-globe" />,
  Plus: () => <span data-testid="icon-plus" />,
  X: () => <span data-testid="icon-x-close" />,
}));

describe('McpServersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists configured servers after load', async () => {
    vi.mocked(api.mcp.listServers).mockResolvedValue(
      mockTypedResponse({
        servers: [
          { name: 'pixellab', transport: 'stdio', command: 'npx', scope: 'global' },
          { name: 'remote', transport: 'http', url: 'https://x/sse', scope: 'project' },
        ],
      } as never),
    );

    render(<McpServersTab />);

    expect(await screen.findByTestId('mcp-server-pixellab')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-server-remote')).toBeInTheDocument();
    expect(screen.getByText('npx')).toBeInTheDocument();
    expect(screen.getByText('https://x/sse')).toBeInTheDocument();
  });

  it('shows the empty state when no servers are configured', async () => {
    vi.mocked(api.mcp.listServers).mockResolvedValue(
      mockTypedResponse({ servers: [] } as never),
    );

    render(<McpServersTab />);

    expect(await screen.findByText(/No MCP servers configured/i)).toBeInTheDocument();
  });

  it('probes connection status when "Test connections" is clicked', async () => {
    vi.mocked(api.mcp.listServers).mockResolvedValue(
      mockTypedResponse({
        servers: [{ name: 'pixellab', transport: 'stdio', command: 'npx', scope: 'global' }],
      } as never),
    );
    vi.mocked(api.mcp.test).mockResolvedValue(
      mockTypedResponse({
        results: [{ name: 'pixellab', status: 'connected', toolCount: 5 }],
      } as never),
    );

    render(<McpServersTab />);
    const button = await screen.findByTestId('mcp-test-button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(api.mcp.test).toHaveBeenCalled();
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText(/5 tools/)).toBeInTheDocument();
      expect(screen.getByText(/Test complete: 1 connected/)).toBeInTheDocument();
    });
  });

  it('adds a server via the form', async () => {
    vi.mocked(api.mcp.listServers).mockResolvedValue(
      mockTypedResponse({ servers: [] } as never),
    );
    vi.mocked(api.mcp.addServer).mockResolvedValue(
      mockTypedResponse(
        {
          server: { name: 'playwright', transport: 'stdio', command: 'npx', scope: 'global' },
        } as never,
        { status: 201 },
      ),
    );

    render(<McpServersTab />);
    fireEvent.click(await screen.findByTestId('mcp-add-button'));

    fireEvent.change(screen.getByTestId('mcp-name-input'), { target: { value: 'playwright' } });
    fireEvent.change(screen.getByTestId('mcp-command-input'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByTestId('mcp-args-input'), { target: { value: '-y @playwright/mcp' } });
    fireEvent.click(screen.getByTestId('mcp-submit-button'));

    await waitFor(() => {
      expect(api.mcp.addServer).toHaveBeenCalledWith({
        transport: 'stdio',
        name: 'playwright',
        command: 'npx',
        args: ['-y', '@playwright/mcp'],
        env: undefined,
        scope: 'global',
      });
      expect(screen.getByTestId('mcp-server-playwright')).toBeInTheDocument();
    });
  });

  it('adds an HTTP server with headers via the form', async () => {
    vi.mocked(api.mcp.listServers).mockResolvedValue(
      mockTypedResponse({ servers: [] } as never),
    );
    vi.mocked(api.mcp.addServer).mockResolvedValue(
      mockTypedResponse(
        {
          server: {
            name: 'pixellab',
            transport: 'http',
            url: 'https://api.pixellab.ai/mcp',
            scope: 'global',
          },
        } as never,
        { status: 201 },
      ),
    );

    render(<McpServersTab />);
    fireEvent.click(await screen.findByTestId('mcp-add-button'));

    fireEvent.change(screen.getByTestId('mcp-name-input'), { target: { value: 'pixellab' } });
    fireEvent.change(screen.getByTestId('mcp-transport-select'), { target: { value: 'http' } });
    fireEvent.change(screen.getByTestId('mcp-url-input'), {
      target: { value: 'https://api.pixellab.ai/mcp' },
    });
    fireEvent.change(screen.getByTestId('mcp-headers-input'), {
      target: { value: '{"Authorization": "Bearer my-token"}' },
    });
    fireEvent.click(screen.getByTestId('mcp-submit-button'));

    await waitFor(() => {
      expect(api.mcp.addServer).toHaveBeenCalledWith({
        transport: 'http',
        name: 'pixellab',
        url: 'https://api.pixellab.ai/mcp',
        headers: { Authorization: 'Bearer my-token' },
        scope: 'global',
      });
      expect(screen.getByTestId('mcp-server-pixellab')).toBeInTheDocument();
    });
  });

  it('surfaces a probe error', async () => {
    vi.mocked(api.mcp.listServers).mockResolvedValue(
      mockTypedResponse({
        servers: [{ name: 'pixellab', transport: 'stdio', command: 'npx', scope: 'global' }],
      } as never),
    );
    vi.mocked(api.mcp.test).mockResolvedValue(
      mockTypedResponse({ error: 'MCP probe failed: boom' } as never, { ok: false, status: 500 }),
    );

    render(<McpServersTab />);
    fireEvent.click(await screen.findByTestId('mcp-test-button'));

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
