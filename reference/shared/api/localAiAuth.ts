// Shared request/response types for the Local AI auth REST endpoints.

export interface LocalAiAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  url: string;
  urlPath: string | null;
  maxOutputTokens: number;
  contextWindowTokens: number;
  disableProxy: boolean;
  reason?: string;
}

export interface SetLocalAiUrlRequest {
  url: string;
}

export interface SetLocalAiUrlResponse {
  ok: true;
  urlPath: string;
}

export interface ClearLocalAiUrlResponse {
  cleared: boolean;
}

export interface SetLocalAiMaxTokensRequest {
  maxOutputTokens: number;
}

export interface SetLocalAiMaxTokensResponse {
  ok: true;
  maxOutputTokens: number;
}

export interface SetLocalAiContextWindowRequest {
  contextWindowTokens: number;
}

export interface SetLocalAiContextWindowResponse {
  ok: true;
  contextWindowTokens: number;
}

export interface SetLocalAiDisableProxyRequest {
  disableProxy: boolean;
}

export interface SetLocalAiDisableProxyResponse {
  ok: true;
  disableProxy: boolean;
}

export interface LocalAiModelEntry {
  id: string;
  name: string;
}

export interface LocalAiModelsResponse {
  models: LocalAiModelEntry[];
}
