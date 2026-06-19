import express, { type Request, type Response } from 'express';
import {
  readGitHubToken,
  writeGitHubToken,
  clearGitHubToken,
} from '../services/githubCredentials.js';
import {
  startGitHubDeviceFlow,
  cancelGitHubDeviceFlow,
  getActiveDeviceFlowSession,
} from '../services/githubAuthFlow.js';
import { validateBody } from '../middleware/validate.js';
import { SaveGitHubTokenBodySchema, type SaveGitHubTokenBody } from '../../shared/schemas/github.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

function log(
  req: Pick<Request, 'baseUrl' | 'path' | 'user'>,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    '[GitHubAuthRoute]',
    JSON.stringify({
      message,
      userId: req.user?.id ?? null,
      path: `${req.baseUrl || ''}${req.path || ''}`,
      ...extra,
    }),
  );
}

// GET /status
router.get('/status', async (req: Request, res: Response) => {
  try {
    log(req, 'status-request');
    const userId = req.user!.id;
    const token = readGitHubToken(userId);
    const session = getActiveDeviceFlowSession(userId);
    const hasDeviceFlowConfig = Boolean(process.env.GITHUB_OAUTH_CLIENT_ID);

    let username: string | null = null;
    if (token) {
      try {
        const ghRes = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Bottega',
          },
        });
        if (ghRes.ok) {
          const ghData = (await ghRes.json()) as { login?: string };
          username = ghData.login ?? null;
        }
      } catch {
        // ignore — token might still be valid
      }
    }

    res.json({
      connected: Boolean(token),
      username,
      hasDeviceFlow: Boolean(session),
      hasDeviceFlowConfig,
      userCode: session?.userCode ?? null,
      verificationUri: session?.verificationUri ?? null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(req, 'status-error', { error: message });
    res.status(500).json({ error: 'Failed to get GitHub auth status' } satisfies ApiError);
  }
});

// POST /device/start
router.post('/device/start', async (req: Request, res: Response) => {
  try {
    log(req, 'device-start-request');
    const userId = req.user!.id;
    const result = await startGitHubDeviceFlow(userId);
    log(req, 'device-start-response', { userCode: result.userCode });
    res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(req, 'device-start-error', { error: message });
    res.status(500).json({ error: message } satisfies ApiError);
  }
});

// POST /device/cancel
router.post('/device/cancel', async (req: Request, res: Response) => {
  try {
    log(req, 'device-cancel-request');
    const userId = req.user!.id;
    await cancelGitHubDeviceFlow(userId);
    res.json({ cancelled: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(req, 'device-cancel-error', { error: message });
    res.status(500).json({ error: 'Failed to cancel device flow' } satisfies ApiError);
  }
});

// POST /token — save a PAT directly
router.post(
  '/token',
  validateBody(SaveGitHubTokenBodySchema),
  (req: Request, res: Response) => {
    try {
      log(req, 'save-token-request');
      const userId = req.user!.id;
      const { token } = req.validated!.body as SaveGitHubTokenBody;
      writeGitHubToken(userId, token);
      log(req, 'save-token-response');
      res.json({ saved: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(req, 'save-token-error', { error: message });
      res.status(500).json({ error: 'Failed to save GitHub token' } satisfies ApiError);
    }
  },
);

// DELETE / — remove token
router.delete('/', (req: Request, res: Response) => {
  try {
    log(req, 'disconnect-request');
    const userId = req.user!.id;
    const cleared = clearGitHubToken(userId);
    log(req, 'disconnect-response', { cleared });
    res.json({ cleared });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(req, 'disconnect-error', { error: message });
    res.status(500).json({ error: 'Failed to remove GitHub token' } satisfies ApiError);
  }
});

export default router;
