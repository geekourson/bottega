import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the home directory + file read so we can feed a crafted ~/.claude.json.
vi.mock('os', () => ({ default: { homedir: () => '/home/test' }, homedir: () => '/home/test' }));

const readFile = vi.fn();
const writeFile = vi.fn();
const rename = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const promises = {
    ...actual.promises,
    readFile: (...args: unknown[]) => readFile(...args),
    writeFile: (...args: unknown[]) => writeFile(...args),
    rename: (...args: unknown[]) => rename(...args),
  };
  return { ...actual, default: { ...actual, promises }, promises };
});

// Probe dependencies.
const loadMcpConfig = vi.fn();
vi.mock('./conversation/sdkOptions.js', () => ({
  loadMcpConfig: (...args: unknown[]) => loadMcpConfig(...args),
}));
vi.mock('./conversation/mcpReadiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversation/mcpReadiness.js')>();
  return {
    ...actual,
    waitForMcpServers: vi.fn(
      async (
        queryInstance: { mcpServerStatus: () => Promise<unknown> },
        _timeout?: number,
        _requiredNames?: string[],
      ) => {
        await queryInstance.mcpServerStatus();
      },
    ),
  };
});
vi.mock('./claudeCredentials.js', () => ({
  ensureFreshClaudeToken: vi.fn().mockResolvedValue(undefined),
  buildClaudeSdkEnv: vi.fn().mockReturnValue({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }),
}));
const query = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...args: unknown[]) => query(...args) }));

function mockQueryIterator(statusFn: ReturnType<typeof vi.fn>) {
  return {
    mcpServerStatus: statusFn,
    [Symbol.asyncIterator]: () => ({
      next: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ done: false, value: { type: 'system' } }), 10);
          }),
      ),
    }),
  };
}

import { listConfiguredMcpServers, probeMcpServers, addConfiguredMcpServer } from './mcpStatus.js';

describe('mcpStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('listConfiguredMcpServers', () => {
    it('returns [] when ~/.claude.json is missing', async () => {
      readFile.mockRejectedValueOnce(new Error('ENOENT'));
      expect(await listConfiguredMcpServers()).toEqual([]);
    });

    it('returns [] on malformed JSON', async () => {
      readFile.mockResolvedValueOnce('{ not json');
      expect(await listConfiguredMcpServers()).toEqual([]);
    });

    it('lists global servers with transport + scope, without leaking env', async () => {
      readFile.mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            pixellab: { command: 'npx', args: ['-y', 'pixellab-mcp'], env: { PIXELLAB_API_KEY: 'secret' } },
            remote: { url: 'https://mcp.example.com/sse' },
          },
        }),
      );

      const servers = await listConfiguredMcpServers();

      expect(servers).toEqual([
        { name: 'pixellab', transport: 'stdio', command: 'npx', url: undefined, scope: 'global' },
        { name: 'remote', transport: 'http', command: undefined, url: 'https://mcp.example.com/sse', scope: 'global' },
      ]);
      // No secret should appear anywhere in the serialized output.
      expect(JSON.stringify(servers)).not.toContain('secret');
    });

    it('merges per-project servers (matching cwd) and labels their scope', async () => {
      readFile.mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: { global1: { command: 'node' } },
          claudeProjects: {
            '/repo': { mcpServers: { projOnly: { command: 'python' } } },
            '/other': { mcpServers: { ignored: { command: 'x' } } },
          },
        }),
      );

      const servers = await listConfiguredMcpServers('/repo');
      const names = servers.map((s) => s.name);

      expect(names).toContain('global1');
      expect(names).toContain('projOnly');
      expect(names).not.toContain('ignored');
      expect(servers.find((s) => s.name === 'projOnly')?.scope).toBe('project');
    });
  });

  describe('addConfiguredMcpServer', () => {
    it('creates ~/.claude.json with a global stdio server when the file is missing', async () => {
      readFile.mockRejectedValueOnce({ code: 'ENOENT' });
      writeFile.mockResolvedValueOnce(undefined);
      rename.mockResolvedValueOnce(undefined);

      const server = await addConfiguredMcpServer({
        name: 'playwright',
        scope: 'global',
        config: { command: 'npx', args: ['-y', '@playwright/mcp'] },
      });

      expect(server).toEqual({
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        url: undefined,
        scope: 'global',
      });
      expect(writeFile).toHaveBeenCalledWith(
        '/home/test/.claude.json.tmp',
        expect.stringContaining('"playwright"'),
        'utf8',
      );
      expect(rename).toHaveBeenCalledWith('/home/test/.claude.json.tmp', '/home/test/.claude.json');
      const written = JSON.parse(String(writeFile.mock.calls[0][1]));
      expect(written.mcpServers.playwright).toEqual({
        command: 'npx',
        args: ['-y', '@playwright/mcp'],
      });
    });

    it('adds an HTTP server to an existing global config', async () => {
      readFile.mockResolvedValueOnce(JSON.stringify({ mcpServers: { existing: { command: 'node' } } }));
      writeFile.mockResolvedValueOnce(undefined);
      rename.mockResolvedValueOnce(undefined);

      const server = await addConfiguredMcpServer({
        name: 'remote',
        scope: 'global',
        config: {
          url: 'https://mcp.example.com/sse',
          transport: 'http',
          headers: { Authorization: 'Bearer secret-token' },
        },
      });

      expect(server.transport).toBe('http');
      expect(server.url).toBe('https://mcp.example.com/sse');
      const written = JSON.parse(String(writeFile.mock.calls[0][1]));
      expect(written.mcpServers.remote).toEqual({
        url: 'https://mcp.example.com/sse',
        transport: 'http',
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(written.mcpServers.existing).toEqual({ command: 'node' });
    });

    it('adds a project-scoped server under claudeProjects[cwd]', async () => {
      readFile.mockResolvedValueOnce(JSON.stringify({ mcpServers: {} }));
      writeFile.mockResolvedValueOnce(undefined);
      rename.mockResolvedValueOnce(undefined);

      const server = await addConfiguredMcpServer({
        name: 'local',
        scope: 'project',
        cwd: '/repo',
        config: { command: 'python' },
      });

      expect(server.scope).toBe('project');
      const written = JSON.parse(String(writeFile.mock.calls[0][1]));
      expect(written.claudeProjects['/repo'].mcpServers.local).toEqual({ command: 'python' });
    });

    it('rejects duplicate global server names', async () => {
      readFile.mockResolvedValueOnce(JSON.stringify({ mcpServers: { dup: { command: 'x' } } }));

      await expect(
        addConfiguredMcpServer({
          name: 'dup',
          scope: 'global',
          config: { command: 'y' },
        }),
      ).rejects.toThrow(/already exists/);
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe('probeMcpServers', () => {
    it('returns [] without launching when no servers are configured', async () => {
      loadMcpConfig.mockResolvedValueOnce(null);
      const results = await probeMcpServers(1);
      expect(results).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it('reports live status + tool count from mcpServerStatus()', async () => {
      loadMcpConfig.mockResolvedValueOnce({ pixellab: { command: 'npx' } });
      query.mockReturnValue(
        mockQueryIterator(
          vi.fn().mockResolvedValue([
            {
              name: 'pixellab',
              status: 'connected',
              serverInfo: { name: 'pixellab', version: '1.2.3' },
              tools: [{}, {}, {}],
            },
          ]),
        ),
      );

      const results = await probeMcpServers(1);

      expect(results).toEqual([
        expect.objectContaining({
          name: 'pixellab',
          status: 'connected',
          version: '1.2.3',
          toolCount: 3,
        }),
      ]);
    });

    it('marks a configured server "unknown" when the SDK reports others but not it', async () => {
      loadMcpConfig.mockResolvedValueOnce({ ghost: { command: 'npx' }, other: { command: 'npx' } });
      query.mockReturnValue(
        mockQueryIterator(
          vi.fn().mockResolvedValue([{ name: 'other', status: 'connected', tools: [{}] }]),
        ),
      );

      const results = await probeMcpServers(1);
      const byName = Object.fromEntries(results.map((r) => [r.name, r]));
      expect(byName.ghost).toEqual({
        name: 'ghost',
        status: 'unknown',
        error: 'Server did not respond before the probe timed out',
      });
      expect(byName.other?.status).toBe('connected');
    });
  });
});
