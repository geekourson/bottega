import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_CLAUDE_CONFIG_ROOT = path.join(os.homedir(), '.config', 'bottega', 'users');
const TOKEN_FILE_NAME = 'oauth_token';

// Claude's public OAuth client — same value the CLI uses.
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Proactively refresh when fewer than 5 minutes remain.
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
}
// Per https://code.claude.com/docs/en/authentication#authentication-precedence
// these env vars take precedence over CLAUDE_CODE_OAUTH_TOKEN. We strip them
// from any env we hand the SDK or a spawned `claude` so the per-user token
// we set actually wins.
const GLOBAL_CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export class ClaudeCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCredentialsError';
  }
}

function normalizeUserId(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (
    !Number.isInteger(numericUserId) ||
    numericUserId <= 0 ||
    String(numericUserId) !== String(userId)
  ) {
    throw new ClaudeCredentialsError('Cannot launch Claude without a valid authenticated user ID');
  }
  return String(numericUserId);
}

export function getClaudeConfigRoot(): string {
  return process.env.CLAUDE_CONFIG_ROOT || DEFAULT_CLAUDE_CONFIG_ROOT;
}

export function resolveClaudeUserDir(userId: number | string | undefined): string {
  return path.join(getClaudeConfigRoot(), normalizeUserId(userId));
}

export function resolveClaudeOAuthTokenPath(userId: number | string | undefined): string {
  return path.join(resolveClaudeUserDir(userId), TOKEN_FILE_NAME);
}

// Kept for the login subprocess sandbox (claude setup-token may write a
// .claude.json settings file). SDK invocations no longer use this — the OAuth
// token env var is the only auth signal.
export function resolveClaudeConfigDir(userId: number | string | undefined): string {
  return path.join(resolveClaudeUserDir(userId), '.claude');
}

function ensureUserDir(userId: number | string | undefined): string {
  const userDir = resolveClaudeUserDir(userId);
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(userDir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ClaudeCredentialsError(
        `Claude credential directory is not writable: ${getClaudeConfigRoot()}. Check permissions or set CLAUDE_CONFIG_ROOT in your .env to a writable path.`,
      );
    }
    throw error;
  }
  return userDir;
}

function validateTokenFileSecurity(
  userId: number | string | undefined,
  tokenPath: string,
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(tokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClaudeCredentialsError(
        `Claude OAuth token is not provisioned for user ${userId}. Run setup-token via /api/claude-auth.`,
      );
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new ClaudeCredentialsError(
      `Claude OAuth token path for user ${userId} is not a file: ${tokenPath}`,
    );
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new ClaudeCredentialsError(
      `Claude OAuth token for user ${userId} must be owned by the current user`,
    );
  }

  if ((stats.mode & 0o077) !== 0) {
    throw new ClaudeCredentialsError(
      `Claude OAuth token for user ${userId} must not be accessible by group or other users; run chmod 600 ${tokenPath}`,
    );
  }
}

export interface ReadClaudeTokenResult {
  token: string;
  tokenPath: string;
}

function parseCredentialsFile(content: string): ClaudeOAuthCredentials {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.accessToken === 'string' && parsed.accessToken) {
        return {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
        };
      }
    } catch {
      // fall through to plain-string path
    }
  }
  return { accessToken: trimmed };
}

function readClaudeOAuthCredentials(
  userId: number | string | undefined,
): ClaudeOAuthCredentials & { tokenPath: string } {
  const tokenPath = resolveClaudeOAuthTokenPath(userId);
  validateTokenFileSecurity(userId, tokenPath);

  const content = fs.readFileSync(tokenPath, 'utf8');
  if (!content.trim()) {
    throw new ClaudeCredentialsError(
      `Claude OAuth token file is empty for user ${userId}: ${tokenPath}`,
    );
  }
  return { ...parseCredentialsFile(content), tokenPath };
}

export function readClaudeOAuthToken(
  userId: number | string | undefined,
): ReadClaudeTokenResult {
  const { accessToken, tokenPath } = readClaudeOAuthCredentials(userId);
  return { token: accessToken, tokenPath };
}

export function writeClaudeOAuthToken(
  userId: number | string | undefined,
  token: unknown,
): string {
  if (typeof token !== 'string' || !token.trim()) {
    throw new ClaudeCredentialsError(
      `Refusing to persist empty Claude OAuth token for user ${userId}`,
    );
  }
  ensureUserDir(userId);
  const tokenPath = resolveClaudeOAuthTokenPath(userId);
  fs.writeFileSync(tokenPath, token.trim(), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  return tokenPath;
}

export function writeClaudeOAuthCredentials(
  userId: number | string | undefined,
  creds: ClaudeOAuthCredentials,
): string {
  if (!creds.accessToken.trim()) {
    throw new ClaudeCredentialsError(
      `Refusing to persist empty Claude OAuth token for user ${userId}`,
    );
  }
  ensureUserDir(userId);
  const tokenPath = resolveClaudeOAuthTokenPath(userId);
  fs.writeFileSync(tokenPath, JSON.stringify(creds), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  return tokenPath;
}

export async function refreshClaudeOAuthToken(
  userId: number | string | undefined,
): Promise<string> {
  const creds = readClaudeOAuthCredentials(userId);
  if (!creds.refreshToken) {
    throw new ClaudeCredentialsError(
      `No refresh token for user ${userId}. Re-authenticate via Settings → Connect Claude.`,
    );
  }

  // Matches the Claude CLI: JSON body, includes the inference scope.
  const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: 'user:inference',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ClaudeCredentialsError(
      `OAuth token refresh failed for user ${userId}: HTTP ${response.status} ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
  };

  if (!data.access_token) {
    throw new ClaudeCredentialsError(
      `OAuth token refresh response missing access_token for user ${userId}`,
    );
  }

  const newCreds: ClaudeOAuthCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: data.expires_at
      ? data.expires_at * 1000
      : data.expires_in
        ? Date.now() + data.expires_in * 1000
        : creds.expiresAt,
  };

  writeClaudeOAuthCredentials(userId, newCreds);
  console.log(`[ClaudeCredentials] Token refreshed for user ${userId}`);
  return newCreds.accessToken;
}

export async function ensureFreshClaudeToken(
  userId: number | string | undefined,
): Promise<void> {
  let creds: ClaudeOAuthCredentials;
  try {
    creds = readClaudeOAuthCredentials(userId);
  } catch {
    return;
  }

  if (!creds.expiresAt || !creds.refreshToken) return;

  const timeUntilExpiry = creds.expiresAt - Date.now();
  if (timeUntilExpiry > TOKEN_REFRESH_AHEAD_MS) return;

  console.log(
    `[ClaudeCredentials] Token for user ${userId} expires in ${Math.round(timeUntilExpiry / 1000)}s — refreshing`,
  );
  try {
    await refreshClaudeOAuthToken(userId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[ClaudeCredentials] Proactive token refresh failed for user ${userId}: ${msg}`);
  }
}

export function clearClaudeOAuthToken(userId: number | string | undefined): boolean {
  const tokenPath = resolveClaudeOAuthTokenPath(userId);
  try {
    fs.unlinkSync(tokenPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// Back-compat alias: tests and a few callers still import this name.
// Returns the same shape as readClaudeOAuthToken for new callers.
export function validateClaudeCredentials(
  userId: number | string | undefined,
): ReadClaudeTokenResult {
  return readClaudeOAuthToken(userId);
}

function validateClaudeConfigDirSecurity(
  userId: number | string | undefined,
  claudeConfigDir: string,
): void {
  let dirStats: fs.Stats;
  try {
    dirStats = fs.statSync(claudeConfigDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClaudeCredentialsError(
        `Claude config directory missing for user ${userId}: ${claudeConfigDir}`,
      );
    }
    throw err;
  }

  if (!dirStats.isDirectory()) {
    throw new ClaudeCredentialsError(
      `Claude config path for user ${userId} is not a directory: ${claudeConfigDir}`,
    );
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && dirStats.uid !== currentUid) {
    throw new ClaudeCredentialsError(
      `Claude config directory for user ${userId} must be owned by the current user`,
    );
  }

  if ((dirStats.mode & 0o077) !== 0) {
    throw new ClaudeCredentialsError(
      `Claude config directory for user ${userId} must not be accessible by group or other users; run chmod 700 ${claudeConfigDir}`,
    );
  }
}

// Used by the setup-token login flow as a private sandbox so that subprocess
// state (settings, telemetry) for one user can't leak into another's.
export function prepareClaudeConfigDir(
  userId: number | string | undefined,
): { claudeConfigDir: string } {
  ensureUserDir(userId);
  const claudeConfigDir = resolveClaudeConfigDir(userId);
  try {
    fs.mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(claudeConfigDir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ClaudeCredentialsError(
        `Claude credential directory is not writable: ${getClaudeConfigRoot()}. Check permissions or set CLAUDE_CONFIG_ROOT in your .env to a writable path.`,
      );
    }
    throw error;
  }
  validateClaudeConfigDirSecurity(userId, claudeConfigDir);
  return { claudeConfigDir };
}

function removeInheritedClaudeAuthEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const key of GLOBAL_CLAUDE_AUTH_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export interface ClaudeSdkEnv extends Record<string, string | undefined> {
  CLAUDE_CODE_OAUTH_TOKEN: string;
  HOME: string | undefined;
  PATH: string | undefined;
  ANTHROPIC_API_KEY: undefined;
  ANTHROPIC_AUTH_TOKEN: undefined;
}

// Sparse env handed to the SDK's `query({ options: { env } })`. The token is
// scoped to inference per the docs (no Remote Control), which matches our use.
export function buildClaudeSdkEnv(userId: number | string | undefined): ClaudeSdkEnv {
  const { token } = readClaudeOAuthToken(userId);

  return {
    CLAUDE_CODE_OAUTH_TOKEN: token,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
  };
}

// Full env for child_process.spawn('claude', …) — strips inherited auth, then
// sets the per-user OAuth token so it isn't fighting an inherited one.
export function buildClaudeSpawnEnv(
  userId: number | string | undefined,
): Record<string, string | undefined> {
  const { token } = readClaudeOAuthToken(userId);
  const env: Record<string, string | undefined> = { ...process.env };
  removeInheritedClaudeAuthEnv(env);
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

// Login subprocess (`claude setup-token`) — must NOT inherit any auth, so the
// CLI runs the fresh OAuth flow instead of reusing existing creds.
export function buildClaudeLoginEnv(
  userId: number | string | undefined,
): Record<string, string | undefined> {
  const { claudeConfigDir } = prepareClaudeConfigDir(userId);

  // Block browser-opening commands so the Claude CLI cannot open a browser
  // automatically. Without a browser, it falls back to the manual code flow
  // (redirect_uri=platform.claude.com), which shows the user a code to paste
  // back into this app. We do this by prepending a temp dir with no-op shims
  // for `open` (macOS) and `xdg-open` (Linux) to the subprocess PATH.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-login-'));
  for (const cmd of ['open', 'xdg-open']) {
    const shimPath = path.join(shimDir, cmd);
    fs.writeFileSync(shimPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    // Force wide terminal so the OAuth URL stays on one line and can be extracted.
    COLUMNS: '1000',
    PATH: `${shimDir}:${process.env.PATH}`,
  };
  removeInheritedClaudeAuthEnv(env);
  return env;
}

export interface ClaudeAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  tokenPath: string;
  tokenFingerprint?: string;
  reason?: string;
}

export async function getClaudeAuthStatus(
  userId: number | string | undefined,
): Promise<ClaudeAuthStatus> {
  const tokenPath = resolveClaudeOAuthTokenPath(userId);
  try {
    const { token } = readClaudeOAuthToken(userId);
    return {
      authenticated: true,
      status: 'authenticated',
      tokenPath,
      tokenFingerprint: token.slice(-6),
    };
  } catch (error) {
    if (error instanceof ClaudeCredentialsError) {
      return {
        authenticated: false,
        status: 'missing',
        reason: error.message,
        tokenPath,
      };
    }
    throw error;
  }
}

export function getQueryProcessPid(queryInstance: unknown): number | null {
  const q = queryInstance as
    | {
        transport?: { process?: { pid?: number } };
        process?: { pid?: number };
        childProcess?: { pid?: number };
      }
    | null
    | undefined;
  return q?.transport?.process?.pid ?? q?.process?.pid ?? q?.childProcess?.pid ?? null;
}

export interface AuditClaudeLaunchArgs {
  source: string;
  userId?: number | string | undefined;
  pid?: number | null | undefined;
  conversationId?: number | null | undefined;
  claudeSessionId?: string | null | undefined;
  cwd?: string | null | undefined;
}

export function auditClaudeLaunch({
  source,
  userId,
  pid,
  conversationId,
  claudeSessionId,
  cwd,
}: AuditClaudeLaunchArgs): void {
  console.log(
    '[ClaudeCredentials] Launch audit:',
    JSON.stringify({
      source,
      userId,
      pid: pid ?? 'unavailable',
      conversationId: conversationId ?? null,
      claudeSessionId: claudeSessionId ?? null,
      cwd: cwd ?? null,
    }),
  );
}
