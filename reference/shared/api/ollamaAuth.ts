// Shared request/response types for the Ollama auth REST endpoints.

export interface OllamaAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  url: string;
  urlPath: string | null;
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

export interface OllamaModelEntry {
  id: string;
  name: string;
  size?: string;
}

export interface OllamaModelsResponse {
  models: OllamaModelEntry[];
}
