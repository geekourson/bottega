import { writeGitHubToken } from './githubCredentials.js';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_SCOPE = 'repo,read:org';

interface DeviceFlowSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
  pollTimer: ReturnType<typeof setInterval> | null;
}

const activeSessions = new Map<number, DeviceFlowSession>();

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log('[GitHubAuthFlow]', JSON.stringify({ message, ...extra }));
}

export async function startGitHubDeviceFlow(
  userId: number,
): Promise<{ userCode: string; verificationUri: string; expiresAt: string }> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error('GITHUB_OAUTH_CLIENT_ID is not configured');
  }

  // Cancel any existing session for this user
  await cancelGitHubDeviceFlow(userId);

  log('start-device-flow', { userId });

  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ client_id: clientId, scope: GITHUB_SCOPE }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub device flow start failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
  };

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error('GitHub device flow response missing required fields');
  }

  const expiresAt = Date.now() + (data.expires_in ?? 900) * 1000;
  const interval = (data.interval ?? 5) * 1000;

  const session: DeviceFlowSession = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt,
    interval,
    pollTimer: null,
  };

  activeSessions.set(userId, session);

  // Start polling in background
  const pollTimer = setInterval(() => {
    void pollGitHubToken(userId, clientId);
  }, interval);
  pollTimer.unref?.();
  session.pollTimer = pollTimer;

  log('device-flow-started', {
    userId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function pollGitHubToken(userId: number, clientId: string): Promise<void> {
  const session = activeSessions.get(userId);
  if (!session) return;

  if (Date.now() >= session.expiresAt) {
    log('device-flow-expired', { userId });
    await cancelGitHubDeviceFlow(userId);
    return;
  }

  try {
    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      log('poll-http-error', { userId, status: response.status });
      return;
    }

    const data = (await response.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };

    if (data.access_token) {
      log('token-received', { userId });
      writeGitHubToken(userId, data.access_token);
      await cancelGitHubDeviceFlow(userId);
      return;
    }

    if (data.error === 'slow_down' && data.interval) {
      // Increase interval — reschedule
      if (session.pollTimer) {
        clearInterval(session.pollTimer);
      }
      session.interval = data.interval * 1000;
      const newTimer = setInterval(() => {
        void pollGitHubToken(userId, clientId);
      }, session.interval);
      newTimer.unref?.();
      session.pollTimer = newTimer;
      log('slow-down', { userId, newInterval: session.interval });
      return;
    }

    if (data.error === 'authorization_pending') {
      // Normal — keep polling
      return;
    }

    if (data.error === 'expired_token' || data.error === 'access_denied') {
      log('device-flow-cancelled', { userId, reason: data.error });
      await cancelGitHubDeviceFlow(userId);
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('poll-error', { userId, error: message });
  }
}

export async function cancelGitHubDeviceFlow(userId: number): Promise<void> {
  const session = activeSessions.get(userId);
  if (!session) return;
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  activeSessions.delete(userId);
  log('cancelled', { userId });
}

export function getActiveDeviceFlowSession(userId: number): DeviceFlowSession | null {
  return activeSessions.get(userId) ?? null;
}
