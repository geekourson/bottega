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
  writeOllamaMaxTokens,
  writeOllamaContextWindow,
  writeOllamaMaxConcurrentTasks,
  readOllamaInstances,
  writeOllamaInstances,
  deleteOllamaInstance,
} from '../services/ollamaCredentials.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import type {
  ClearOllamaUrlResponse,
  OllamaAuthStatusResponse,
  OllamaModelsResponse,
  SetOllamaUrlResponse,
  SetOllamaMaxTokensResponse,
  SetOllamaContextWindowResponse,
  SetOllamaMaxConcurrentTasksResponse,
  GetOllamaInstancesResponse,
  AddOllamaInstanceResponse,
  DeleteOllamaInstanceResponse,
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
        maxOutputTokens: status.maxOutputTokens,
        contextWindowTokens: status.contextWindowTokens,
        maxConcurrentTasks: status.maxConcurrentTasks,
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

router.put(
  '/max-tokens',
  async (req: Request, res: Response<SetOllamaMaxTokensResponse | OllamaAuthErrorBody>) => {
    const body = req.body as { maxOutputTokens?: unknown };
    const raw = Number(body.maxOutputTokens);
    if (!Number.isFinite(raw) || raw < 1000) {
      return res.status(400).json({
        error: 'maxOutputTokens must be a number ≥ 1000',
        code: 'OLLAMA_AUTH_INVALID_PAYLOAD',
      });
    }
    const tokens = Math.round(raw);
    try {
      await writeOllamaMaxTokens(req.user!.id, tokens);
      res.status(201).json({ ok: true, maxOutputTokens: tokens });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/context-window',
  async (req: Request, res: Response<SetOllamaContextWindowResponse | OllamaAuthErrorBody>) => {
    const body = req.body as { contextWindowTokens?: unknown };
    const raw = Number(body.contextWindowTokens);
    if (!Number.isFinite(raw) || raw < 1000) {
      return res.status(400).json({
        error: 'contextWindowTokens must be a number ≥ 1000',
        code: 'OLLAMA_AUTH_INVALID_PAYLOAD',
      });
    }
    const tokens = Math.round(raw);
    try {
      await writeOllamaContextWindow(req.user!.id, tokens);
      res.status(201).json({ ok: true, contextWindowTokens: tokens });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/max-concurrent-tasks',
  async (req: Request, res: Response<SetOllamaMaxConcurrentTasksResponse | OllamaAuthErrorBody>) => {
    const body = req.body as { maxConcurrentTasks?: unknown };
    const raw = Number(body.maxConcurrentTasks);
    if (!Number.isInteger(raw) || raw < 1) {
      return res.status(400).json({
        error: 'maxConcurrentTasks must be an integer ≥ 1',
        code: 'OLLAMA_AUTH_INVALID_PAYLOAD',
      });
    }
    try {
      await writeOllamaMaxConcurrentTasks(req.user!.id, raw);
      res.status(201).json({ ok: true, maxConcurrentTasks: raw });
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

router.get(
  '/instances',
  (req: Request, res: Response<GetOllamaInstancesResponse | OllamaAuthErrorBody>) => {
    const instances = readOllamaInstances(req.user!.id);
    res.json({ instances });
  },
);

router.post(
  '/instances',
  async (req: Request, res: Response<AddOllamaInstanceResponse | OllamaAuthErrorBody>) => {
    const body = req.body as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return res.status(400).json({ error: 'url is required', code: 'OLLAMA_AUTH_INVALID_PAYLOAD' });
    }
    try {
      const current = readOllamaInstances(req.user!.id);
      if (current.some((i) => i.url === url)) {
        return res.status(409).json({ error: 'Instance already exists', code: 'OLLAMA_AUTH_INVALID_PAYLOAD' });
      }
      await writeOllamaInstances(req.user!.id, [...current, { url }]);
      res.status(201).json({ ok: true, instances: readOllamaInstances(req.user!.id) });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/instances',
  async (req: Request, res: Response<DeleteOllamaInstanceResponse | OllamaAuthErrorBody>) => {
    const body = req.body as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return res.status(400).json({ error: 'url is required', code: 'OLLAMA_AUTH_INVALID_PAYLOAD' });
    }
    try {
      await deleteOllamaInstance(req.user!.id, url);
      res.json({ ok: true, instances: readOllamaInstances(req.user!.id) });
    } catch (error) {
      authErrorResponse(res as Response<OllamaAuthErrorBody | ApiError>, error);
    }
  },
);

export default router;
