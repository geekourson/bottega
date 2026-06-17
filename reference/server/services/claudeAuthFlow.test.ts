import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelClaudeAuthLogin,
  clearClaudeAuthLoginSessions,
  ClaudeAuthLoginError,
  completeClaudeAuthLogin,
  getActiveClaudeAuthLogin,
  startClaudeAuthLogin,
} from './claudeAuthFlow.js';

vi.mock('./claudeCredentials.js', () => ({
  writeClaudeOAuthCredentials: vi.fn(),
  getClaudeAuthStatus: vi.fn().mockResolvedValue({
    authenticated: true,
    status: 'authenticated',
    tokenFingerprint: 'abcdef',
  }),
}));

// Capture the fetch mock so tests can control it
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockTokenResponse(overrides: Record<string, unknown> = {}): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      access_token: 'sk-ant-oat01-test-token',
      refresh_token: 'sk-ant-ort01-test-refresh',
      expires_in: 31536000,
      ...overrides,
    }),
    text: async () => '',
  });
}

function mockTokenError(status = 400, body = 'invalid_grant'): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({ error: body }),
  });
}

describe('claudeAuthFlow (PKCE direct)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearClaudeAuthLoginSessions();
  });

  describe('startClaudeAuthLogin', () => {
    it('returns an auth URL with correct PKCE params', async () => {
      const login = await startClaudeAuthLogin(42);

      expect(login.loginSessionId).toEqual(expect.any(String));
      expect(login.authUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize/);
      expect(login.authUrl).toContain('code=true');
      expect(login.authUrl).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(login.authUrl).toContain('response_type=code');
      expect(login.authUrl).toContain('code_challenge_method=S256');
      expect(login.authUrl).toContain('code_challenge=');
      expect(login.authUrl).toContain('state=');
      expect(login.startedAt).toEqual(expect.any(String));
      expect(login.expiresAt).toEqual(expect.any(String));
    });

    it('each call produces a unique loginSessionId, codeChallenge and state', async () => {
      const a = await startClaudeAuthLogin(42, { ttlMs: 60000 });
      const b = await startClaudeAuthLogin(43, { ttlMs: 60000 });

      expect(a.loginSessionId).not.toBe(b.loginSessionId);
      const urlA = new URL(a.authUrl!);
      const urlB = new URL(b.authUrl!);
      expect(urlA.searchParams.get('code_challenge')).not.toBe(
        urlB.searchParams.get('code_challenge'),
      );
      expect(urlA.searchParams.get('state')).not.toBe(urlB.searchParams.get('state'));
    });

    it('cancels any previous active session for the same user', async () => {
      const first = await startClaudeAuthLogin(42);
      const second = await startClaudeAuthLogin(42);

      expect(first.loginSessionId).not.toBe(second.loginSessionId);
      const active = getActiveClaudeAuthLogin(42);
      expect(active?.loginSessionId).toBe(second.loginSessionId);
    });

    it('rejects invalid user IDs', async () => {
      await expect(startClaudeAuthLogin(0 as unknown as number)).rejects.toThrow(
        ClaudeAuthLoginError,
      );
    });
  });

  describe('getActiveClaudeAuthLogin', () => {
    it('returns the active session for the user', async () => {
      const login = await startClaudeAuthLogin(42);
      const active = getActiveClaudeAuthLogin(42);

      expect(active?.loginSessionId).toBe(login.loginSessionId);
      expect(active?.authUrl).toBe(login.authUrl);
    });

    it('returns null when no session is active', () => {
      expect(getActiveClaudeAuthLogin(99)).toBeNull();
    });
  });

  describe('cancelClaudeAuthLogin', () => {
    it('removes the active session and returns true', async () => {
      await startClaudeAuthLogin(42);
      expect(cancelClaudeAuthLogin(42)).toBe(true);
      expect(getActiveClaudeAuthLogin(42)).toBeNull();
    });

    it('returns false when no session exists', () => {
      expect(cancelClaudeAuthLogin(99)).toBe(false);
    });
  });

  // The pasted code is `authorizationCode#state`; the state must match the one
  // embedded in the authorize URL for that login session.
  function stateOf(authUrl: string | null): string {
    return new URL(authUrl!).searchParams.get('state') as string;
  }

  describe('completeClaudeAuthLogin', () => {
    it('exchanges the code (JSON body, code#state) for tokens and persists them', async () => {
      const { writeClaudeOAuthCredentials } = await import('./claudeCredentials.js');
      const login = await startClaudeAuthLogin(42);
      mockTokenResponse();

      const status = await completeClaudeAuthLogin(
        42,
        login.loginSessionId,
        `auth-code-123#${stateOf(login.authUrl)}`,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://platform.claude.com/v1/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      // The body is JSON with the code split from the state.
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(
        expect.objectContaining({
          grant_type: 'authorization_code',
          code: 'auth-code-123',
          state: stateOf(login.authUrl),
          code_verifier: expect.any(String),
        }),
      );
      expect(writeClaudeOAuthCredentials).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          accessToken: 'sk-ant-oat01-test-token',
          refreshToken: 'sk-ant-ort01-test-refresh',
        }),
      );
      expect(status.authenticated).toBe(true);
    });

    it('rejects a code missing the #state suffix', async () => {
      const login = await startClaudeAuthLogin(42);
      await expect(
        completeClaudeAuthLogin(42, login.loginSessionId, 'auth-code-without-state'),
      ).rejects.toThrow(/full code/i);
    });

    it('rejects a code whose state does not match the session', async () => {
      const login = await startClaudeAuthLogin(42);
      await expect(
        completeClaudeAuthLogin(42, login.loginSessionId, 'auth-code-123#wrong-state'),
      ).rejects.toThrow(/does not match/i);
    });

    it('throws when no active session exists', async () => {
      await expect(completeClaudeAuthLogin(42, 'no-such-session', 'code')).rejects.toThrow(
        /No active Claude authentication session/,
      );
    });

    it('throws when loginSessionId is stale', async () => {
      await startClaudeAuthLogin(42);
      await expect(completeClaudeAuthLogin(42, 'wrong-id', 'code')).rejects.toThrow(
        /replaced/i,
      );
    });

    it('throws when the code is empty', async () => {
      const login = await startClaudeAuthLogin(42);
      await expect(completeClaudeAuthLogin(42, login.loginSessionId, '')).rejects.toThrow(
        /valid Claude authentication code/,
      );
    });

    it('propagates a 400 from the token endpoint', async () => {
      const login = await startClaudeAuthLogin(42);
      mockTokenError(400, 'invalid_grant');

      await expect(
        completeClaudeAuthLogin(42, login.loginSessionId, `bad-code#${stateOf(login.authUrl)}`),
      ).rejects.toThrow(/rejected the authentication code/i);
    });

    it('clears the session after a successful exchange', async () => {
      const login = await startClaudeAuthLogin(42);
      mockTokenResponse();

      await completeClaudeAuthLogin(42, login.loginSessionId, `auth-code-123#${stateOf(login.authUrl)}`);

      expect(getActiveClaudeAuthLogin(42)).toBeNull();
    });
  });
});
