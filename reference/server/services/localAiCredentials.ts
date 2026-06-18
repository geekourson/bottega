// Per-user Local AI credential helpers.
//
// "Local AI" covers any local inference server that exposes an
// Anthropic-compatible API: llama-server (llama.cpp), LM Studio, Jan.ai, etc.
// No secret credential is needed — the only configuration is the base URL.
//
// Storage: `~/.config/bottega/users/{userId}/local-ai-url` — a plain-text
// file containing just the URL. Falls back to http://localhost:8080 (the
// llama-server / llama.cpp default) when absent.
//
// Model listing hits the OpenAI-compatible `GET /v1/models` endpoint, which
// all major local-inference servers expose.

import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_LOCAL_AI_URL = 'http://localhost:8080';
const DEFAULT_MAX_OUTPUT_TOKENS = 64000;

export class LocalAiCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAiCredentialsError';
  }
}

function resolveUserDir(userId: number | string | undefined): string {
  const id = userId != null ? String(userId) : 'unknown';
  return path.join(os.homedir(), '.config', 'bottega', 'users', id);
}

function resolveUrlFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'local-ai-url');
}

function resolveMaxTokensFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'local-ai-max-tokens');
}

export function resolveLocalAiUrlPath(userId: number | string | undefined): string {
  return resolveUrlFilePath(userId);
}

export function readLocalAiUrl(userId: number | string | undefined): {
  url: string;
  urlPath: string;
} {
  const urlPath = resolveUrlFilePath(userId);
  try {
    const raw = readFileSync(urlPath, 'utf8').trim();
    return { url: raw || DEFAULT_LOCAL_AI_URL, urlPath };
  } catch {
    return { url: DEFAULT_LOCAL_AI_URL, urlPath };
  }
}

export async function writeLocalAiUrl(
  userId: number | string | undefined,
  url: string,
): Promise<{ urlPath: string }> {
  const urlPath = resolveUrlFilePath(userId);
  await fs.mkdir(path.dirname(urlPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(urlPath, url.trim(), { mode: 0o600 });
  return { urlPath };
}

export function readLocalAiMaxTokens(userId: number | string | undefined): number {
  const filePath = resolveMaxTokensFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
  } catch {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
}

export async function writeLocalAiMaxTokens(
  userId: number | string | undefined,
  tokens: number,
): Promise<void> {
  const filePath = resolveMaxTokensFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, String(tokens), { mode: 0o600 });
}

export async function clearLocalAiUrl(
  userId: number | string | undefined,
): Promise<boolean> {
  const urlPath = resolveUrlFilePath(userId);
  try {
    await fs.unlink(urlPath);
    return true;
  } catch {
    return false;
  }
}

export interface LocalAiAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  urlPath: string;
  url: string;
  maxOutputTokens: number;
  reason?: string;
}

export async function getLocalAiAuthStatus(
  userId: number | string | undefined,
): Promise<LocalAiAuthStatus> {
  const { url, urlPath } = readLocalAiUrl(userId);
  const maxOutputTokens = readLocalAiMaxTokens(userId);
  try {
    // GET /v1/models is available on all major local servers and doubles as a
    // health check — if it responds with a 2xx we consider the server live.
    const res = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return { authenticated: true, status: 'authenticated', urlPath, url, maxOutputTokens };
    }
    return {
      authenticated: false,
      status: 'missing',
      urlPath,
      url,
      maxOutputTokens,
      reason: `Server returned HTTP ${res.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      authenticated: false,
      status: 'missing',
      urlPath,
      url,
      maxOutputTokens,
      reason: `Cannot reach server at ${url}: ${message}`,
    };
  }
}

export interface LocalAiModelEntry {
  /** Persistence form: `local-ai/<id>`. */
  id: string;
  /** Bare model id as the server knows it. */
  name: string;
}

export async function listLocalAiModels(
  userId: number | string | undefined,
): Promise<LocalAiModelEntry[]> {
  const { url } = readLocalAiUrl(userId);
  const res = await fetch(`${url}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new LocalAiCredentialsError(
      `Local AI /v1/models returned HTTP ${res.status} — is the server running at ${url}?`,
    );
  }
  const body = (await res.json()) as {
    data?: Array<{ id: string; [key: string]: unknown }>;
  };
  const data = body.data ?? [];
  return data
    .filter((m) => m.id)
    .map((m) => ({
      id: `local-ai/${m.id}`,
      name: m.id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildLocalAiSdkEnv(
  userId: number | string | undefined,
): Record<string, string | undefined> {
  const { url } = readLocalAiUrl(userId);
  const maxTokens = readLocalAiMaxTokens(userId);
  console.log(
    `[LocalAiCredentials] buildLocalAiSdkEnv userId=${userId} CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxTokens} url=${url}`,
  );
  return {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: 'local-ai',
    ANTHROPIC_AUTH_TOKEN: undefined,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
}
