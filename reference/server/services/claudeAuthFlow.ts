// Direct PKCE OAuth 2.0 flow for Claude / Anthropic authentication.
//
// This module implements the same OAuth PKCE flow the Claude CLI uses, but
// without spawning a `claude setup-token` subprocess. No node-pty required.
//
// Flow:
//   1. startClaudeAuthLogin  — generates PKCE + state, returns the authorize URL.
//   2. Frontend opens the URL in a new browser tab (ClaudeAuthPanel.tsx).
//   3. User authorizes at claude.com → lands on platform.claude.com which shows
//      the authorization code.
//   4. User pastes the code into Bottega.
//   5. completeClaudeAuthLogin — exchanges the code for tokens and persists them.

import crypto from 'crypto';
import {
  getClaudeAuthStatus,
  writeClaudeOAuthCredentials,
} from './claudeCredentials.js';
import type { ClaudeAuthStatus } from './claudeCredentials.js';

const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// `claude setup-token` requests exactly this single scope. The broader
// `claude auth login` scope set (org:create_api_key, …) gets rejected with
// "Invalid request format" for accounts that can't grant org-level scopes.
const CLAUDE_SCOPE = 'user:inference';

const DEFAULT_LOGIN_TTL_MS = 10 * 60 * 1000; // 10 min

interface LoginSession {
  id: string;
  userId: number | string;
  userKey: string;
  codeVerifier: string;
  state: string;
  startedAt: string;
  expiresAt: string;
  authUrl: string;
  ttlTimer: NodeJS.Timeout;
}

interface PublicSession {
  loginSessionId: string;
  authUrl: string | null;
  startedAt: string;
  expiresAt: string;
}

const activeLogins = new Map<string, LoginSession>();

export class ClaudeAuthLoginError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'ClaudeAuthLoginError';
    this.statusCode = statusCode;
  }
}

function normalizeUserKey(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    throw new ClaudeAuthLoginError('Cannot authenticate Claude without a valid user ID', 400);
  }
  return String(numericUserId);
}

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log('[ClaudeAuthFlow]', JSON.stringify({ message, ...extra }));
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function buildAuthUrl(codeChallenge: string, state: string): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
  url.searchParams.set('scope', CLAUDE_SCOPE);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

export function getActiveClaudeAuthLogin(
  userId: number | string | undefined,
): PublicSession | null {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) return null;
  return {
    loginSessionId: session.id,
    authUrl: session.authUrl,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
  };
}

export function cancelClaudeAuthLogin(
  userId: number | string | undefined,
  reason = 'cancelled',
): boolean {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) {
    log('cancel-request-no-active-session', { userId, reason });
    return false;
  }
  clearTimeout(session.ttlTimer);
  activeLogins.delete(userKey);
  log('cancel-request', { userId, reason, loginSessionId: session.id });
  return true;
}

export interface StartLoginOptions {
  ttlMs?: number;
  urlWaitMs?: number; // kept for API compat, unused in PKCE flow
}

export async function startClaudeAuthLogin(
  userId: number | string,
  options: StartLoginOptions = {},
): Promise<PublicSession> {
  const userKey = normalizeUserKey(userId);
  const ttlMs =
    options.ttlMs ||
    Number(process.env.CLAUDE_AUTH_LOGIN_TTL_MS) ||
    DEFAULT_LOGIN_TTL_MS;

  log('start-request', { userId, ttlMs });
  cancelClaudeAuthLogin(userId, 'replaced');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  // Claude's authorize endpoint expects a 32-byte state (43 base64url chars),
  // same as the CLI. A shorter state is rejected with "Invalid request format".
  const state = crypto.randomBytes(32).toString('base64url');
  const authUrl = buildAuthUrl(codeChallenge, state);

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const expiresAt = new Date(startedAtMs + ttlMs).toISOString();

  const session: LoginSession = {
    id: crypto.randomUUID(),
    userId,
    userKey,
    codeVerifier,
    state,
    startedAt,
    expiresAt,
    authUrl,
    ttlTimer: undefined as unknown as NodeJS.Timeout,
  };

  session.ttlTimer = setTimeout(() => {
    if (activeLogins.get(userKey)?.id === session.id) {
      log('login-session-expired', { userId, loginSessionId: session.id });
      activeLogins.delete(userKey);
    }
  }, ttlMs);
  session.ttlTimer.unref?.();

  activeLogins.set(userKey, session);
  log('start-response', {
    userId,
    loginSessionId: session.id,
    hasAuthUrl: true,
    expiresAt,
  });

  return { loginSessionId: session.id, authUrl, startedAt, expiresAt };
}

export interface CompleteLoginOptions {
  completeWaitMs?: number; // kept for API compat, unused in PKCE flow
}

export async function completeClaudeAuthLogin(
  userId: number | string,
  loginSessionId: string,
  code: unknown,
  _options: CompleteLoginOptions = {},
): Promise<ClaudeAuthStatus> {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);

  if (!session) {
    log('complete-request-no-active-session', { userId, loginSessionId });
    throw new ClaudeAuthLoginError('No active Claude authentication session', 404);
  }
  if (session.id !== loginSessionId) {
    log('complete-request-replaced-session', {
      userId,
      submittedLoginSessionId: loginSessionId,
    });
    throw new ClaudeAuthLoginError('Claude authentication session has been replaced', 409);
  }
  if (Date.now() >= Date.parse(session.expiresAt)) {
    log('complete-request-expired', { userId, loginSessionId });
    cancelClaudeAuthLogin(userId, 'expired');
    throw new ClaudeAuthLoginError('Claude authentication link expired', 410);
  }

  const trimmedCode = typeof code === 'string' ? code.trim() : '';
  if (!trimmedCode || trimmedCode.length > 4096 || trimmedCode.includes('\0')) {
    throw new ClaudeAuthLoginError('A valid Claude authentication code is required', 400);
  }

  // Claude's manual paste flow shows the code as `authorizationCode#state`.
  // The CLI splits on `#` and sends the two parts separately. A code without
  // the `#state` suffix means the user only copied part of it.
  const [authCode, returnedState] = trimmedCode.split('#');
  if (!authCode || !returnedState) {
    throw new ClaudeAuthLoginError(
      'Invalid code. Make sure the full code (including the part after #) was copied',
      400,
    );
  }
  if (returnedState !== session.state) {
    log('complete-request-state-mismatch', { userId, loginSessionId });
    throw new ClaudeAuthLoginError(
      'Claude authentication code does not match this login session. Start the login again.',
      400,
    );
  }

  log('exchanging-code', { userId, loginSessionId, codeLength: authCode.length });

  let tokenData: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
  };
  try {
    // The token endpoint expects a JSON body (matching the Claude CLI), not
    // form-urlencoded, and the `state` field alongside the code.
    const response = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: authCode,
        state: returnedState,
        redirect_uri: CLAUDE_REDIRECT_URI,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        code_verifier: session.codeVerifier,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log('token-exchange-failed', { userId, status: response.status, body: body.slice(0, 200) });
      throw new ClaudeAuthLoginError(
        `Claude rejected the authentication code: HTTP ${response.status} — ${body.slice(0, 200)}`,
        400,
      );
    }

    tokenData = (await response.json()) as typeof tokenData;
  } catch (error) {
    if (error instanceof ClaudeAuthLoginError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    log('token-exchange-error', { userId, error: msg });
    throw new ClaudeAuthLoginError(`Token exchange network error: ${msg}`, 500);
  }

  if (!tokenData.access_token) {
    throw new ClaudeAuthLoginError('Token exchange response missing access_token', 500);
  }

  clearTimeout(session.ttlTimer);
  activeLogins.delete(userKey);

  try {
    writeClaudeOAuthCredentials(userId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_at
        ? tokenData.expires_at * 1000
        : tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('token-persist-failed', { userId, error: msg });
    throw new ClaudeAuthLoginError(`Failed to persist Claude OAuth token: ${msg}`, 500);
  }

  log('complete-success', {
    userId,
    loginSessionId,
    hasRefreshToken: Boolean(tokenData.refresh_token),
  });

  const status = await getClaudeAuthStatus(userId);
  if (!status.authenticated) {
    throw new ClaudeAuthLoginError(
      'Claude authentication completed, but credentials are not usable yet',
      500,
    );
  }
  return status;
}

export function clearClaudeAuthLoginSessions(): void {
  for (const session of activeLogins.values()) {
    clearTimeout(session.ttlTimer);
  }
  activeLogins.clear();
}
