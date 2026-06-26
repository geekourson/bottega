// Local AI proxy server.
//
// Sits between the Claude Code SDK subprocess and the local inference server
// (LM Studio, llama-server, Ollama, etc.) and intercepts "preflight" requests
// that the SDK sends with max_tokens=1 to measure context size. These
// requests are real inference calls on local hardware — they occupy a full
// VRAM slot and can exhaust GPU memory when sent in parallel. The proxy
// short-circuits them with a synthetic response derived from a simple
// character-based token estimate, then forwards all other requests normally.
//
// Usage:
//   await ensureLocalAiProxy(lmStudioUrl);  // idempotent, starts once
//   const url = getLocalAiProxyUrl();       // 'http://127.0.0.1:<port>' or null

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

let proxyServer: http.Server | null = null;
let cachedProxyUrl: string | null = null;
let targetBaseUrl = 'http://localhost:8080';
let proxyReadyPromise: Promise<string> | null = null;

// Rough token estimate: ~4 chars per token for mixed code/English content.
function estimateTokens(value: unknown): number {
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  if (Array.isArray(value)) {
    return (value as unknown[]).reduce<number>((sum, v) => sum + estimateTokens(v), 0);
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    // For content blocks, only the text field contributes tokens.
    if (rec.type === 'text' && typeof rec.text === 'string') return estimateTokens(rec.text);
    return Object.values(rec).reduce<number>((sum, v) => sum + estimateTokens(v), 0);
  }
  return 0;
}

function buildSyntheticResponse(model: string, inputTokens: number): string {
  return JSON.stringify({
    id: `msg_proxy_count_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '.' }],
    model,
    stop_reason: 'max_tokens',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 1 },
  });
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyBuffer: Buffer,
): void {
  const rawUrl = req.url ?? '/';
  let target: URL;
  try {
    target = new URL(rawUrl, targetBaseUrl);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const isHttps = target.protocol === 'https:';
  const port = target.port
    ? parseInt(target.port, 10)
    : isHttps
      ? 443
      : 80;

  const forwardHeaders: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: target.host,
  };
  if (bodyBuffer.length > 0) {
    forwardHeaders['content-length'] = String(bodyBuffer.length);
  } else {
    delete forwardHeaders['content-length'];
  }

  const options: http.RequestOptions = {
    hostname: target.hostname,
    port,
    path: target.pathname + target.search,
    method: req.method,
    headers: forwardHeaders,
  };

  const transport = isHttps ? https : http;
  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[LocalAiProxy] Forward error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad Gateway');
  });

  if (bodyBuffer.length > 0) proxyReq.write(bodyBuffer);
  proxyReq.end();
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('error', () => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);

    if (req.method === 'POST' && req.url === '/v1/messages') {
      try {
        const parsed = JSON.parse(bodyBuffer.toString('utf8')) as Record<string, unknown>;
        if (parsed.max_tokens === 1) {
          const inputTokens = estimateTokens({
            system: parsed.system,
            messages: parsed.messages,
          });
          const syntheticBody = buildSyntheticResponse(
            typeof parsed.model === 'string' ? parsed.model : 'local-ai',
            inputTokens,
          );
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(syntheticBody)),
          });
          res.end(syntheticBody);
          return;
        }
      } catch {
        // Malformed JSON — forward normally.
      }
    }

    forwardRequest(req, res, bodyBuffer);
  });
}

function startProxy(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      proxyServer = server;
      cachedProxyUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[LocalAiProxy] Started on ${cachedProxyUrl} → ${targetBaseUrl}`);
      resolve(cachedProxyUrl);
    });
    server.on('error', (err) => {
      proxyReadyPromise = null;
      reject(err);
    });
  });
}

/**
 * Start the proxy (idempotent) and point it at `lmStudioUrl`.
 * Returns the proxy base URL to use as ANTHROPIC_BASE_URL.
 *
 * When `disableProxy` is true, the proxy is bypassed entirely and the
 * direct `lmStudioUrl` is returned (max_tokens=1 preflight requests will
 * go straight to LM Studio as before).
 */
export async function ensureLocalAiProxy(
  lmStudioUrl: string,
  disableProxy = false,
): Promise<string> {
  const bare = lmStudioUrl.replace(/\/$/, '');

  if (disableProxy) {
    return bare;
  }

  targetBaseUrl = bare;

  if (cachedProxyUrl && proxyServer) {
    return cachedProxyUrl;
  }

  if (!proxyReadyPromise) {
    proxyReadyPromise = startProxy();
  }

  return proxyReadyPromise;
}

/** Returns the cached proxy URL, or null if the proxy hasn't been started yet. */
export function getLocalAiProxyUrl(): string | null {
  return cachedProxyUrl;
}

export function stopLocalAiProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
  cachedProxyUrl = null;
  proxyReadyPromise = null;
}
