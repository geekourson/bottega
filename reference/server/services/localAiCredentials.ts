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
import { getLocalAiProxyUrl } from './localAiProxy.js';
import { localAiPool } from './instancePool.js';

export const DEFAULT_LOCAL_AI_URL = 'http://localhost:8080';
const DEFAULT_MAX_OUTPUT_TOKENS = 64000;
// Conservative default — most llama.cpp/LM Studio setups run with a small
// configured context. Raise it in Settings → Providers → Local AI to match
// whatever the server is actually configured with.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;

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

function resolveContextWindowFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'local-ai-context-window');
}

function resolveDisableProxyFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'local-ai-disable-proxy');
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

export function readLocalAiContextWindow(userId: number | string | undefined): number {
  const filePath = resolveContextWindowFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW_TOKENS;
  } catch {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
}

export async function writeLocalAiContextWindow(
  userId: number | string | undefined,
  tokens: number,
): Promise<void> {
  const filePath = resolveContextWindowFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, String(tokens), { mode: 0o600 });
}

export function readLocalAiDisableProxy(userId: number | string | undefined): boolean {
  const filePath = resolveDisableProxyFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    return raw === 'true';
  } catch {
    return false;
  }
}

export async function writeLocalAiDisableProxy(
  userId: number | string | undefined,
  disable: boolean,
): Promise<void> {
  const filePath = resolveDisableProxyFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, String(disable), { mode: 0o600 });
}

function resolveInstancesFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'local-ai-instances.json');
}

export interface LocalAiInstance {
  url: string;
}

export function readLocalAiInstances(userId: number | string | undefined): LocalAiInstance[] {
  const filePath = resolveInstancesFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // File exists (even if empty) — use its content, no migration.
      return (parsed as LocalAiInstance[]).filter((e) => typeof e?.url === 'string' && e.url.length > 0);
    }
  } catch {
    // File absent → fall through to legacy single-URL migration.
  }
  // Migration: old single-URL file → treat as one instance.
  const { url } = readLocalAiUrl(userId);
  return [{ url }];
}

export async function writeLocalAiInstances(
  userId: number | string | undefined,
  instances: LocalAiInstance[],
): Promise<void> {
  const filePath = resolveInstancesFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(instances, null, 2), { mode: 0o600 });
  // Sync pool and queue.
  const { localAiGpuQueue } = await import('./localGpuQueue.js');
  localAiPool.setInstances(instances.map((i) => i.url));
  localAiGpuQueue.setMaxConcurrent(Math.max(1, instances.length));
}

export async function deleteLocalAiInstance(
  userId: number | string | undefined,
  url: string,
): Promise<void> {
  const current = readLocalAiInstances(userId);
  const next = current.filter((i) => i.url !== url);
  await writeLocalAiInstances(userId, next);
}

export function initLocalAiPool(userId: number | string | undefined): void {
  const instances = readLocalAiInstances(userId);
  import('./localGpuQueue.js').then(({ localAiGpuQueue }) => {
    localAiPool.setInstances(instances.map((i) => i.url));
    localAiGpuQueue.setMaxConcurrent(Math.max(1, instances.length));
  }).catch(() => {});
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
  contextWindowTokens: number;
  disableProxy: boolean;
  reason?: string;
}

export async function getLocalAiAuthStatus(
  userId: number | string | undefined,
): Promise<LocalAiAuthStatus> {
  // Ping the first configured instance; fall back to legacy URL if none.
  const instances = readLocalAiInstances(userId);
  const { urlPath } = readLocalAiUrl(userId);
  const url = instances[0]?.url ?? readLocalAiUrl(userId).url;
  const maxOutputTokens = readLocalAiMaxTokens(userId);
  const contextWindowTokens = readLocalAiContextWindow(userId);
  const disableProxy = readLocalAiDisableProxy(userId);
  try {
    // GET /v1/models is available on all major local servers and doubles as a
    // health check — if it responds with a 2xx we consider the server live.
    const res = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return { authenticated: true, status: 'authenticated', urlPath, url, maxOutputTokens, contextWindowTokens, disableProxy };
    }
    return {
      authenticated: false,
      status: 'missing',
      urlPath,
      url,
      maxOutputTokens,
      contextWindowTokens,
      disableProxy,
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
      contextWindowTokens,
      disableProxy,
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
  const instances = readLocalAiInstances(userId);
  const url = instances[0]?.url ?? readLocalAiUrl(userId).url;
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
  assignedUrl?: string,
): Record<string, string | undefined> {
  const { url: defaultUrl } = readLocalAiUrl(userId);
  const maxTokens = readLocalAiMaxTokens(userId);
  const disableProxy = readLocalAiDisableProxy(userId);
  const baseUrl = assignedUrl ?? defaultUrl;
  const effectiveUrl = disableProxy ? baseUrl : (getLocalAiProxyUrl() ?? baseUrl);
  console.log(
    `[LocalAiCredentials] buildLocalAiSdkEnv userId=${userId} CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxTokens} url=${effectiveUrl}`,
  );
  return {
    ANTHROPIC_BASE_URL: effectiveUrl,
    ANTHROPIC_API_KEY: 'local-ai',
    ANTHROPIC_AUTH_TOKEN: undefined,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
}
