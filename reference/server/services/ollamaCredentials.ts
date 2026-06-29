// Per-user Ollama credential helpers.
//
// Unlike Anthropic (OAuth) and OpenAI (API key), Ollama needs no secret
// credential — it's a local server. What we store is the base URL
// (default: http://localhost:11434) so power users can point Bottega at a
// non-standard port or a remote Ollama instance.
//
// Storage: `~/.config/bottega/users/{userId}/ollama-url` — a plain text
// file containing just the URL. The file is created on first write; if it
// does not exist we fall back to the default URL and still report
// "authenticated" (because a running default Ollama is indistinguishable
// from an unconfigured one — the health check decides).

import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { ollamaPool } from './instancePool.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MAX_OUTPUT_TOKENS = 64000;
// Ollama's own default num_ctx is 2048 — well under what most models actually
// support. 8192 is a conservative middle ground that fits small models while
// still being large enough for normal multi-turn use; the user can raise it
// in Settings → Providers → Ollama to match whatever they've configured.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;

export class OllamaCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaCredentialsError';
  }
}

function resolveUserDir(userId: number | string | undefined): string {
  const id = userId != null ? String(userId) : 'unknown';
  return path.join(os.homedir(), '.config', 'bottega', 'users', id);
}

function resolveUrlFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'ollama-url');
}

function resolveMaxTokensFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'ollama-max-tokens');
}

function resolveContextWindowFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'ollama-context-window');
}

export function resolveOllamaUrlPath(userId: number | string | undefined): string {
  return resolveUrlFilePath(userId);
}

export function readOllamaUrl(userId: number | string | undefined): {
  url: string;
  urlPath: string;
} {
  const urlPath = resolveUrlFilePath(userId);
  try {
    const raw = readFileSync(urlPath, 'utf8').trim();
    return { url: raw || DEFAULT_OLLAMA_URL, urlPath };
  } catch {
    return { url: DEFAULT_OLLAMA_URL, urlPath };
  }
}

export async function writeOllamaUrl(
  userId: number | string | undefined,
  url: string,
): Promise<{ urlPath: string }> {
  const urlPath = resolveUrlFilePath(userId);
  await fs.mkdir(path.dirname(urlPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(urlPath, url.trim(), { mode: 0o600 });
  return { urlPath };
}

export function readOllamaMaxTokens(userId: number | string | undefined): number {
  const filePath = resolveMaxTokensFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
  } catch {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
}

export async function writeOllamaMaxTokens(
  userId: number | string | undefined,
  tokens: number,
): Promise<void> {
  const filePath = resolveMaxTokensFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, String(tokens), { mode: 0o600 });
}

export function readOllamaContextWindow(userId: number | string | undefined): number {
  const filePath = resolveContextWindowFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW_TOKENS;
  } catch {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
}

export async function writeOllamaContextWindow(
  userId: number | string | undefined,
  tokens: number,
): Promise<void> {
  const filePath = resolveContextWindowFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, String(tokens), { mode: 0o600 });
}

function resolveInstancesFilePath(userId: number | string | undefined): string {
  return path.join(resolveUserDir(userId), 'ollama-instances.json');
}

export interface OllamaInstance {
  url: string;
}

export function readOllamaInstances(userId: number | string | undefined): OllamaInstance[] {
  const filePath = resolveInstancesFilePath(userId);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // File exists (even if empty) — use its content, no migration.
      return (parsed as OllamaInstance[]).filter((e) => typeof e?.url === 'string' && e.url.length > 0);
    }
  } catch {
    // File absent → fall through to legacy single-URL migration.
  }
  // Migration: old single-URL file → treat as one instance.
  const { url } = readOllamaUrl(userId);
  return [{ url }];
}

export async function writeOllamaInstances(
  userId: number | string | undefined,
  instances: OllamaInstance[],
): Promise<void> {
  const filePath = resolveInstancesFilePath(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(instances, null, 2), { mode: 0o600 });
  // Sync pool and queue.
  const { ollamaGpuQueue } = await import('./localGpuQueue.js');
  ollamaPool.setInstances(instances.map((i) => i.url));
  ollamaGpuQueue.setMaxConcurrent(Math.max(1, instances.length));
}

export async function deleteOllamaInstance(
  userId: number | string | undefined,
  url: string,
): Promise<void> {
  const current = readOllamaInstances(userId);
  const next = current.filter((i) => i.url !== url);
  await writeOllamaInstances(userId, next);
}

export function initOllamaPool(userId: number | string | undefined): void {
  const instances = readOllamaInstances(userId);
  import('./localGpuQueue.js').then(({ ollamaGpuQueue }) => {
    ollamaPool.setInstances(instances.map((i) => i.url));
    ollamaGpuQueue.setMaxConcurrent(Math.max(1, instances.length));
  }).catch(() => {});
}

export async function clearOllamaUrl(
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

export interface OllamaAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  urlPath: string;
  url: string;
  maxOutputTokens: number;
  contextWindowTokens: number;
  reason?: string;
}

export async function getOllamaAuthStatus(
  userId: number | string | undefined,
): Promise<OllamaAuthStatus> {
  // Ping the first configured instance; fall back to legacy URL if none.
  const instances = readOllamaInstances(userId);
  const { urlPath } = readOllamaUrl(userId);
  const url = instances[0]?.url ?? readOllamaUrl(userId).url;
  const maxOutputTokens = readOllamaMaxTokens(userId);
  const contextWindowTokens = readOllamaContextWindow(userId);
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return { authenticated: true, status: 'authenticated', urlPath, url, maxOutputTokens, contextWindowTokens };
    }
    return {
      authenticated: false,
      status: 'missing',
      urlPath,
      url,
      maxOutputTokens,
      contextWindowTokens,
      reason: `Ollama returned HTTP ${res.status}`,
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
      reason: `Cannot reach Ollama at ${url}: ${message}`,
    };
  }
}

export function buildOllamaSdkEnv(
  userId: number | string | undefined,
  assignedUrl?: string,
): Record<string, string | undefined> {
  const { url: defaultUrl } = readOllamaUrl(userId);
  const maxTokens = readOllamaMaxTokens(userId);
  const effectiveUrl = assignedUrl ?? defaultUrl;
  console.log(
    `[OllamaCredentials] buildOllamaSdkEnv userId=${userId} CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxTokens} url=${effectiveUrl}`,
  );
  return {
    ANTHROPIC_BASE_URL: effectiveUrl,
    ANTHROPIC_API_KEY: 'ollama',
    ANTHROPIC_AUTH_TOKEN: undefined,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
}

export interface OllamaModelEntry {
  /** Persistence form: `ollama/<name>`. */
  id: string;
  /** Bare model name as Ollama knows it (e.g. `llama3.2`, `qwen2.5-coder:32b`). */
  name: string;
  /** Human-readable size string if Ollama reports it. */
  size?: string;
}

export async function listOllamaModels(
  userId: number | string | undefined,
): Promise<OllamaModelEntry[]> {
  const instances = readOllamaInstances(userId);
  const url = instances[0]?.url ?? readOllamaUrl(userId).url;
  const res = await fetch(`${url}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new OllamaCredentialsError(
      `Ollama /api/tags returned HTTP ${res.status} — is Ollama running at ${url}?`,
    );
  }
  const body = (await res.json()) as {
    models?: Array<{ name: string; size?: number }>;
  };
  const models = body.models ?? [];
  return models
    .map((m) => ({
      id: `ollama/${m.name}`,
      name: m.name,
      ...(m.size !== undefined
        ? { size: `${(m.size / 1e9).toFixed(1)} GB` }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
