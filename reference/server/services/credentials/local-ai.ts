// Local AI adapter for the ProviderCredentialStore interface.
//
// "Local AI" covers any local inference server that exposes an
// Anthropic-compatible API (llama-server, LM Studio, Jan.ai, etc.).
// No secret is needed — the "credential" is the server URL
// (default: http://localhost:8080). Authentication status is determined
// by a live health-check via GET /v1/models. `buildSdkEnv` injects the env
// vars the Claude Agent SDK needs to talk to the local server.

import {
  buildLocalAiSdkEnv,
  clearLocalAiUrl,
  getLocalAiAuthStatus,
  LocalAiCredentialsError,
  readLocalAiUrl,
  resolveLocalAiUrlPath,
  writeLocalAiUrl,
} from '../localAiCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const localAiCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const { url, urlPath } = readLocalAiUrl(userId);
    return { token: url, tokenPath: urlPath };
  },

  write(userId, payload) {
    const url = typeof payload === 'string' ? payload.trim() : '';
    if (!url) {
      throw new LocalAiCredentialsError('Local AI URL must be a non-empty string');
    }
    const urlPath = resolveLocalAiUrlPath(userId);
    void writeLocalAiUrl(userId, url);
    return { tokenPath: urlPath };
  },

  clear(userId) {
    void clearLocalAiUrl(userId);
    return true;
  },

  async getStatus(userId) {
    const status = await getLocalAiAuthStatus(userId);
    return {
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.urlPath,
      tokenFingerprint: status.url,
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    };
  },

  buildSdkEnv(userId) {
    return buildLocalAiSdkEnv(userId);
  },
};

export { LocalAiCredentialsError };
