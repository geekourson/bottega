// MCP server inspection: list what's configured in ~/.claude.json and probe
// live connection status by spinning up a throwaway SDK query.
//
// The configured-list path is cheap (just reads the file). The probe path
// launches the Claude subprocess to ask the SDK `mcpServerStatus()`, which is
// the only source of truth for whether a server actually connects.

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadMcpConfig } from './conversation/sdkOptions.js';
import { waitForMcpServers } from './conversation/mcpReadiness.js';
import { ensureFreshClaudeToken, buildClaudeSdkEnv } from './claudeCredentials.js';

export type McpTransport = 'stdio' | 'http' | 'unknown';
export type McpScope = 'global' | 'project';

export interface ConfiguredMcpServer {
  name: string;
  transport: McpTransport;
  command?: string | undefined;
  url?: string | undefined;
  scope: McpScope;
}

export interface McpServerProbeResult {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'unknown' | string;
  error?: string | undefined;
  version?: string | undefined;
  toolCount?: number | undefined;
  scope?: string | undefined;
}

interface RawMcpConfig {
  command?: unknown;
  url?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

interface SdkMcpStatus {
  name: string;
  status: string;
  error?: string;
  serverInfo?: { name?: string; version?: string };
  tools?: unknown[];
  scope?: string;
}

interface QueryWithMcp {
  mcpServerStatus(): Promise<SdkMcpStatus[]>;
}

function transportOf(config: RawMcpConfig): McpTransport {
  if (typeof config?.command === 'string') return 'stdio';
  if (typeof config?.url === 'string') return 'http';
  return 'unknown';
}

/**
 * List MCP servers configured in ~/.claude.json — global `mcpServers` plus the
 * per-project block matching `cwd` (if provided). Secrets (`env`) are never
 * included in the result.
 */
export async function listConfiguredMcpServers(
  cwd?: string | null,
): Promise<ConfiguredMcpServer[]> {
  const claudeConfigPath = path.join(os.homedir(), '.claude.json');
  let content: string;
  try {
    content = await fs.readFile(claudeConfigPath, 'utf8');
  } catch {
    return [];
  }

  let parsed: {
    mcpServers?: Record<string, RawMcpConfig>;
    claudeProjects?: Record<string, { mcpServers?: Record<string, RawMcpConfig> }>;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const out: ConfiguredMcpServer[] = [];
  const seen = new Set<string>();

  const add = (name: string, config: RawMcpConfig, scope: McpScope) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({
      name,
      transport: transportOf(config),
      command: typeof config.command === 'string' ? config.command : undefined,
      url: typeof config.url === 'string' ? config.url : undefined,
      scope,
    });
  };

  // Project block first so a project server keeps its 'project' scope label.
  if (cwd && parsed.claudeProjects?.[cwd]?.mcpServers) {
    for (const [name, config] of Object.entries(parsed.claudeProjects[cwd].mcpServers!)) {
      add(name, config, 'project');
    }
  }
  if (parsed.mcpServers) {
    for (const [name, config] of Object.entries(parsed.mcpServers)) {
      add(name, config, 'global');
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface AddMcpServerInput {
  name: string;
  scope: McpScope;
  /** Project repo path when scope is `project`. */
  cwd?: string | null;
  config: Record<string, unknown>;
}

function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

async function readClaudeConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(claudeConfigPath(), 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw new Error('~/.claude.json is not valid JSON');
    }
    throw error;
  }
}

async function writeClaudeConfig(parsed: Record<string, unknown>): Promise<void> {
  const target = claudeConfigPath();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

/**
 * Add an MCP server entry to ~/.claude.json (global `mcpServers` or a
 * per-project block). Returns the configured server summary (no secrets).
 */
export async function addConfiguredMcpServer(input: AddMcpServerInput): Promise<ConfiguredMcpServer> {
  const parsed = await readClaudeConfig();

  if (input.scope === 'project') {
    if (!input.cwd) {
      throw new Error('Project path is required for project-scoped MCP servers');
    }
    const claudeProjects =
      (parsed.claudeProjects as Record<string, { mcpServers?: Record<string, RawMcpConfig> }>) ??
      {};
    const projectBlock = claudeProjects[input.cwd] ?? {};
    const mcpServers = projectBlock.mcpServers ?? {};
    if (mcpServers[input.name]) {
      throw new Error(`MCP server "${input.name}" already exists in this project`);
    }
    mcpServers[input.name] = input.config as RawMcpConfig;
    projectBlock.mcpServers = mcpServers;
    claudeProjects[input.cwd] = projectBlock;
    parsed.claudeProjects = claudeProjects;
  } else {
    const mcpServers = (parsed.mcpServers as Record<string, RawMcpConfig>) ?? {};
    if (mcpServers[input.name]) {
      throw new Error(`MCP server "${input.name}" already exists`);
    }
    mcpServers[input.name] = input.config as RawMcpConfig;
    parsed.mcpServers = mcpServers;
  }

  await writeClaudeConfig(parsed);

  return {
    name: input.name,
    transport: transportOf(input.config),
    command: typeof input.config.command === 'string' ? input.config.command : undefined,
    url: typeof input.config.url === 'string' ? input.config.url : undefined,
    scope: input.scope,
  };
}

type QueryIterable = QueryWithMcp & AsyncIterable<unknown>;

/** Kick-start the SDK subprocess — generators don't run until iterated. */
function startQuerySession(q: QueryIterable): { stop: () => void } {
  const iterator = q[Symbol.asyncIterator]();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const { done } = await iterator.next();
        if (done) break;
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

/**
 * Probe live MCP connection status by launching a throwaway query whose prompt
 * never yields a turn — we only read `mcpServerStatus()` then abort. Requires a
 * provisioned Claude OAuth token (the SDK subprocess needs it to start).
 */
export async function probeMcpServers(
  userId: number,
  cwd?: string | null,
): Promise<McpServerProbeResult[]> {
  const mcpServers = await loadMcpConfig(cwd ?? null);
  const configuredNames = mcpServers ? Object.keys(mcpServers) : [];
  if (configuredNames.length === 0) return [];

  await ensureFreshClaudeToken(userId);
  const env = buildClaudeSdkEnv(userId);
  const abortController = new AbortController();

  // A prompt that parks until we abort: enough for the SDK to connect MCP
  // servers, but it never runs a model turn (no token spend, no transcript).
  async function* idlePrompt(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) return resolve();
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  const options: Record<string, unknown> = {
    env,
    model: 'sonnet',
    mcpServers,
    abortController,
    settingSources: ['project', 'user', 'local'],
  };
  if (cwd) options.cwd = cwd;

  let q: QueryIterable;
  try {
    q = query({ prompt: idlePrompt() as never, options: options as never }) as unknown as QueryIterable;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to launch MCP probe: ${message}`);
  }

  const session = startQuerySession(q);

  try {
    await waitForMcpServers(q, 45000, configuredNames);
    const statuses = await q.mcpServerStatus();
    const byName = new Map(statuses.map((s) => [s.name, s]));

    return configuredNames
      .map((name): McpServerProbeResult => {
        const s = byName.get(name);
        if (!s) {
          return {
            name,
            status: 'unknown',
            error: 'Server did not respond before the probe timed out',
          };
        }
        return {
          name,
          status: s.status,
          error: s.error,
          version: s.serverInfo?.version,
          toolCount: Array.isArray(s.tools) ? s.tools.length : undefined,
          scope: s.scope,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    session.stop();
    try {
      abortController.abort();
    } catch {
      /* ignore */
    }
  }
}
