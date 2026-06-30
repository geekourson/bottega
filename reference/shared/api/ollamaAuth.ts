// Shared request/response types for the Ollama auth REST endpoints.

export interface OllamaAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  url: string;
  urlPath: string | null;
  maxOutputTokens: number;
  contextWindowTokens: number;
  maxConcurrentTasks: number;
  reason?: string;
}

export interface SetOllamaUrlRequest {
  url: string;
}

export interface SetOllamaUrlResponse {
  ok: true;
  urlPath: string;
}

export interface ClearOllamaUrlResponse {
  cleared: boolean;
}

export interface SetOllamaMaxTokensRequest {
  maxOutputTokens: number;
}

export interface SetOllamaMaxTokensResponse {
  ok: true;
  maxOutputTokens: number;
}

export interface SetOllamaContextWindowRequest {
  contextWindowTokens: number;
}

export interface SetOllamaContextWindowResponse {
  ok: true;
  contextWindowTokens: number;
}

export interface OllamaModelEntry {
  id: string;
  name: string;
  size?: string;
}

export interface OllamaModelsResponse {
  models: OllamaModelEntry[];
}

export interface SetOllamaMaxConcurrentTasksRequest {
  maxConcurrentTasks: number;
}

export interface SetOllamaMaxConcurrentTasksResponse {
  ok: true;
  maxConcurrentTasks: number;
}

export interface OllamaInstanceEntry {
  url: string;
}

export interface GetOllamaInstancesResponse {
  instances: OllamaInstanceEntry[];
}

export interface AddOllamaInstanceRequest {
  url: string;
}

export interface AddOllamaInstanceResponse {
  ok: true;
  instances: OllamaInstanceEntry[];
}

export interface DeleteOllamaInstanceResponse {
  ok: true;
  instances: OllamaInstanceEntry[];
}
