// Ollama adapter for the ProviderCredentialStore interface.
//
// Ollama requires no secret — the "credential" is the server URL
// (default: http://localhost:11434). Authentication status is determined
// by a live health-check to /api/tags. `buildSdkEnv` injects the three
// env vars the Claude Agent SDK needs to talk to Ollama instead of Anthropic.

import {
  buildOllamaSdkEnv,
  clearOllamaUrl,
  getOllamaAuthStatus,
  OllamaCredentialsError,
  readOllamaUrl,
  resolveOllamaUrlPath,
  writeOllamaUrl,
} from '../ollamaCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const ollamaCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const { url, urlPath } = readOllamaUrl(userId);
    return { token: url, tokenPath: urlPath };
  },

  write(userId, payload) {
    const url = typeof payload === 'string' ? payload.trim() : '';
    if (!url) {
      throw new OllamaCredentialsError('Ollama URL must be a non-empty string');
    }
    // writeOllamaUrl is async; the store contract exposes sync write.
    // We call the sync helper directly here to match the contract.
    const urlPath = resolveOllamaUrlPath(userId);
    void writeOllamaUrl(userId, url);
    return { tokenPath: urlPath };
  },

  clear(userId) {
    // clearOllamaUrl is async; fire-and-forget matches the sync contract.
    void clearOllamaUrl(userId);
    return true;
  },

  async getStatus(userId) {
    const status = await getOllamaAuthStatus(userId);
    return {
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.urlPath,
      tokenFingerprint: status.url,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    };
  },

  buildSdkEnv(userId) {
    return buildOllamaSdkEnv(userId);
  },
};

export { OllamaCredentialsError };
