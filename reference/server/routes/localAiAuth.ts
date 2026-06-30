// /api/local-ai-auth/* — Local AI server authentication, per-user scoped.
//
// Routes:
//   GET    /status     — is the local AI server reachable at the configured URL?
//   PUT    /url        — set or replace the server base URL (default: http://localhost:8080)
//   DELETE /url        — clear the custom URL (reverts to default)
//   PUT    /max-tokens — set max output tokens for this user
//   GET    /models     — live model list via GET /v1/models

import express, { type Request, type Response } from 'express';
import {
  clearLocalAiUrl,
  getLocalAiAuthStatus,
  listLocalAiModels,
  LocalAiCredentialsError,
  writeLocalAiUrl,
  writeLocalAiMaxTokens,
  writeLocalAiContextWindow,
  writeLocalAiDisableProxy,
  writeLocalAiMaxConcurrentTasks,
  readLocalAiInstances,
  writeLocalAiInstances,
  deleteLocalAiInstance,
} from '../services/localAiCredentials.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import type {
  ClearLocalAiUrlResponse,
  LocalAiAuthStatusResponse,
  LocalAiModelsResponse,
  SetLocalAiUrlResponse,
  SetLocalAiMaxTokensResponse,
  SetLocalAiContextWindowResponse,
  SetLocalAiDisableProxyResponse,
  SetLocalAiMaxConcurrentTasksResponse,
  GetLocalAiInstancesResponse,
  AddLocalAiInstanceResponse,
  DeleteLocalAiInstanceResponse,
} from '../../shared/api/localAiAuth.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

interface LocalAiAuthErrorBody {
  error: string;
  code: 'LOCAL_AI_AUTH_STORAGE_ERROR' | 'LOCAL_AI_AUTH_INVALID_PAYLOAD';
}

function authErrorResponse(
  res: Response<LocalAiAuthErrorBody | ApiError>,
  error: unknown,
  fallbackCode: LocalAiAuthErrorBody['code'] = 'LOCAL_AI_AUTH_STORAGE_ERROR',
): Response {
  if (error instanceof LocalAiCredentialsError) {
    return res.status(400).json({ error: error.message, code: fallbackCode });
  }
  console.error('[LocalAiAuth] Error:', error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal error',
    code: fallbackCode,
  });
}

router.get(
  '/status',
  async (req: Request, res: Response<LocalAiAuthStatusResponse | LocalAiAuthErrorBody>) => {
    try {
      const status = await getLocalAiAuthStatus(req.user!.id);
      res.json({
        authenticated: status.authenticated,
        status: status.status,
        url: status.url,
        urlPath: status.urlPath,
        maxOutputTokens: status.maxOutputTokens,
        contextWindowTokens: status.contextWindowTokens,
        disableProxy: status.disableProxy,
        maxConcurrentTasks: status.maxConcurrentTasks,
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
      });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/url',
  async (req: Request, res: Response<SetLocalAiUrlResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return res.status(400).json({
        error: 'url is required',
        code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD',
      });
    }
    try {
      const { urlPath } = await writeLocalAiUrl(req.user!.id, url);
      await seedAgentSettingsAfterConnect(req.user!.id);
      res.status(201).json({ ok: true, urlPath });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/url',
  async (req: Request, res: Response<ClearLocalAiUrlResponse | LocalAiAuthErrorBody>) => {
    try {
      const cleared = await clearLocalAiUrl(req.user!.id);
      res.json({ cleared });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/max-tokens',
  async (req: Request, res: Response<SetLocalAiMaxTokensResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { maxOutputTokens?: unknown };
    const raw = Number(body.maxOutputTokens);
    if (!Number.isFinite(raw) || raw < 1000) {
      return res.status(400).json({
        error: 'maxOutputTokens must be a number ≥ 1000',
        code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD',
      });
    }
    const tokens = Math.round(raw);
    try {
      await writeLocalAiMaxTokens(req.user!.id, tokens);
      res.status(201).json({ ok: true, maxOutputTokens: tokens });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/context-window',
  async (req: Request, res: Response<SetLocalAiContextWindowResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { contextWindowTokens?: unknown };
    const raw = Number(body.contextWindowTokens);
    if (!Number.isFinite(raw) || raw < 1000) {
      return res.status(400).json({
        error: 'contextWindowTokens must be a number ≥ 1000',
        code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD',
      });
    }
    const tokens = Math.round(raw);
    try {
      await writeLocalAiContextWindow(req.user!.id, tokens);
      res.status(201).json({ ok: true, contextWindowTokens: tokens });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/disable-proxy',
  async (req: Request, res: Response<SetLocalAiDisableProxyResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { disableProxy?: unknown };
    if (typeof body.disableProxy !== 'boolean') {
      return res.status(400).json({
        error: 'disableProxy must be a boolean',
        code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD',
      });
    }
    try {
      await writeLocalAiDisableProxy(req.user!.id, body.disableProxy);
      res.status(201).json({ ok: true, disableProxy: body.disableProxy });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/max-concurrent-tasks',
  async (req: Request, res: Response<SetLocalAiMaxConcurrentTasksResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { maxConcurrentTasks?: unknown };
    const raw = Number(body.maxConcurrentTasks);
    if (!Number.isInteger(raw) || raw < 1) {
      return res.status(400).json({
        error: 'maxConcurrentTasks must be an integer ≥ 1',
        code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD',
      });
    }
    try {
      await writeLocalAiMaxConcurrentTasks(req.user!.id, raw);
      res.status(201).json({ ok: true, maxConcurrentTasks: raw });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.get(
  '/models',
  async (req: Request, res: Response<LocalAiModelsResponse | LocalAiAuthErrorBody>) => {
    const userId = req.user!.id;
    try {
      const status = await getLocalAiAuthStatus(userId);
      if (!status.authenticated) {
        res.json({ models: [] });
        return;
      }
      const models = await listLocalAiModels(userId);
      res.json({ models });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.get(
  '/instances',
  (req: Request, res: Response<GetLocalAiInstancesResponse | LocalAiAuthErrorBody>) => {
    const instances = readLocalAiInstances(req.user!.id);
    res.json({ instances });
  },
);

router.post(
  '/instances',
  async (req: Request, res: Response<AddLocalAiInstanceResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return res.status(400).json({ error: 'url is required', code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD' });
    }
    try {
      const current = readLocalAiInstances(req.user!.id);
      if (current.some((i) => i.url === url)) {
        return res.status(409).json({ error: 'Instance already exists', code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD' });
      }
      await writeLocalAiInstances(req.user!.id, [...current, { url }]);
      res.status(201).json({ ok: true, instances: readLocalAiInstances(req.user!.id) });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/instances',
  async (req: Request, res: Response<DeleteLocalAiInstanceResponse | LocalAiAuthErrorBody>) => {
    const body = req.body as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return res.status(400).json({ error: 'url is required', code: 'LOCAL_AI_AUTH_INVALID_PAYLOAD' });
    }
    try {
      await deleteLocalAiInstance(req.user!.id, url);
      res.json({ ok: true, instances: readLocalAiInstances(req.user!.id) });
    } catch (error) {
      authErrorResponse(res as Response<LocalAiAuthErrorBody | ApiError>, error);
    }
  },
);

export default router;
