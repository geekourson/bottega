// /api/ollama-auth/* — Ollama authentication, per-user scoped.
//
// Three routes:
//   - GET    /status — is Ollama reachable at the configured URL?
//   - PUT    /url    — set or replace the Ollama base URL (defaults to
//                      http://localhost:11434).
//   - DELETE /url    — clear the custom URL (reverts to default).
//   - GET    /models — live model list from the Ollama /api/tags endpoint.

import express, { type Request, type Response } from 'express';
import {
  clearOllamaUrl,
  getOllamaAuthStatus,
  listOllamaModels,
  OllamaCredentialsError,
  writeOllamaUrl,
} from '../services/ollamaCredentials.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import type {
  ClearOllamaUrlResponse,
  OllamaAuthStatusResponse,
  OllamaModelsResponse,
  SetOllamaUrlResponse,
} from '../../shared/api/ollamaAuth.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

interface OllamaAuthErrorBody {
  error: string;
  code: 'OLLAMA_AUTH_STORAGE_ERROR' | 'OLLAMA_AUTH_INVALID_PAYLOAD';
}

function authErrorResponse(
  res: Response<OllamaAuthErrorBody | ApiError>,
  error: unknown,
  fallbackCode: OllamaAuthErrorBody['code'] = 'OLLAMA_AUTH_STORAGE_ERROR',
): Response {
  if (error instanceof OllamaCredentialsError) {
    return res.status(400).json({ error: error.message, code: fallbackCode });
  }
  console.error('[OllamaAuth] Error:', error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal error',
    code: fallbackCode,
  });
}

router.get(
  '/status',
  async (req: Request, res: Response<OllamaAuthStatusResponse | OllamaAuthErrorBody>) => {
    try {
      const status = await getOllamaAuthStatus(req.user!.id);
      res.json({
        authenticated: status.authenticated,
        status: status.status,
        url: status.url,
        urlPath: status.urlPath,
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
      });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/url',
  async (req: Request, res: Response<SetOllamaUrlResponse | OllamaAuthErrorBody>) => {
    const body = req.body as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return res.status(400).json({
        error: 'url is required',
        code: 'OLLAMA_AUTH_INVALID_PAYLOAD',
      });
    }
    try {
      const { urlPath } = await writeOllamaUrl(req.user!.id, url);
      // Seed model settings for this user if not already done.
      await seedAgentSettingsAfterConnect(req.user!.id);
      res.status(201).json({ ok: true, urlPath });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/url',
  async (req: Request, res: Response<ClearOllamaUrlResponse | OllamaAuthErrorBody>) => {
    try {
      const cleared = await clearOllamaUrl(req.user!.id);
      res.json({ cleared });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

router.get(
  '/models',
  async (req: Request, res: Response<OllamaModelsResponse | OllamaAuthErrorBody>) => {
    const userId = req.user!.id;
    try {
      const status = await getOllamaAuthStatus(userId);
      if (!status.authenticated) {
        res.json({ models: [] });
        return;
      }
      const models = await listOllamaModels(userId);
      res.json({ models });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

export default router;
