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

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MAX_OUTPUT_TOKENS = 64000;

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
  reason?: string;
}

export async function getOllamaAuthStatus(
  userId: number | string | undefined,
): Promise<OllamaAuthStatus> {
  const { url, urlPath } = readOllamaUrl(userId);
  const maxOutputTokens = readOllamaMaxTokens(userId);
  try {
    const res = await fetch(`${url}/api/tags`, {
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
      reason: `Cannot reach Ollama at ${url}: ${message}`,
    };
  }
}

export function buildOllamaSdkEnv(
  userId: number | string | undefined,
): Record<string, string | undefined> {
  const { url } = readOllamaUrl(userId);
  const maxTokens = readOllamaMaxTokens(userId);
  console.log(
    `[OllamaCredentials] buildOllamaSdkEnv userId=${userId} CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxTokens} url=${url}`,
  );
  return {
    ANTHROPIC_BASE_URL: url,
    // Claude CLI requires a non-empty API key even when routing to Ollama.
    // Ollama ignores the value; using 'ollama' as a conventional placeholder.
    ANTHROPIC_API_KEY: 'ollama',
    // Unset the auth token so the CLI relies solely on ANTHROPIC_API_KEY.
    ANTHROPIC_AUTH_TOKEN: undefined,
    // The SDK uses options.env verbatim (no merge with process.env) when
    // the caller provides an env object. Without HOME and PATH, third-party
    // hooks (e.g. GitKraken gk cli) cannot find their config directories and
    // panic with exit_code 2 — which the Claude CLI interprets as
    // "abort session", killing the subprocess before any prompt is delivered.
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    // Ollama models can produce longer outputs than Anthropic models.
    // The default 32 000-token cap causes "response exceeded maximum" errors.
    // The value is configurable per-user via Settings → Providers → Ollama.
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
  const { url } = readOllamaUrl(userId);
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
