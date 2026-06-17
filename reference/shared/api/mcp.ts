// Request/response shapes for the MCP inspection endpoints:
//  - GET  /api/mcp/servers  (configured list from ~/.claude.json)
//  - POST /api/mcp/servers  (add a server to ~/.claude.json)
//  - POST /api/mcp/test     (live connection probe via a throwaway SDK query)

export type McpTransport = 'stdio' | 'http' | 'unknown';
export type McpScope = 'global' | 'project';

export interface McpConfiguredServer {
  name: string;
  transport: McpTransport;
  command?: string;
  url?: string;
  scope: McpScope;
}

export type McpProbeStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'unknown';

export interface McpProbeResult {
  name: string;
  // Widened to string because the SDK may return statuses we don't model yet.
  status: McpProbeStatus | string;
  error?: string;
  version?: string;
  toolCount?: number;
  scope?: string;
}

export interface ListMcpServersResponse {
  servers: McpConfiguredServer[];
}

export interface TestMcpServersResponse {
  results: McpProbeResult[];
}

export type AddMcpServerRequest =
  | {
      transport: 'stdio';
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      scope?: McpScope;
      projectId?: number;
    }
  | {
      transport: 'http';
      name: string;
      url: string;
      headers?: Record<string, string>;
      scope?: McpScope;
      projectId?: number;
    };

export interface AddMcpServerResponse {
  server: McpConfiguredServer;
}
