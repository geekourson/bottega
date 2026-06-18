// LocalAiProvider — implements `LlmProvider` for any local inference server
// with an Anthropic-compatible API (llama-server/llama.cpp, LM Studio, Jan.ai).
//
// The provider reuses the Claude Agent SDK pointed at the local server via
// `ANTHROPIC_BASE_URL`. Model identifiers are stored as `local-ai/<modelId>`;
// the `local-ai/` prefix is stripped before passing to the SDK.

import { query } from '@anthropic-ai/claude-agent-sdk';

import { mapMessage } from '../anthropic/mapMessage.js';
import { loadAnthropicTranscript } from '../anthropic/sessionStore.js';
import { mapOptionsToSDK } from '../anthropic/sdkOptionsBuilder.js';
import { activeSessions } from '../../conversation/sessionState.js';
import { agentRunsDb } from '../../../database/db.js';
import { getCapabilities } from '@shared/providers/capabilities';
import type {
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
} from '@shared/providers/types';
import type { LlmProvider, LoadTranscriptOptions } from '../types.js';
import type { SDKMessage } from '@shared/sdk/transcript';

const LOCAL_AI_CONCISENESS_NOTE =
  'Be concise and direct. ' +
  'Do not repeat or summarize content you just read. ' +
  'Do not explain what you are about to do — just do it. ' +
  'Write code changes in focused diffs, not entire files, unless the full file is strictly required. ' +
  'Avoid verbose preambles, closing summaries, and redundant commentary.';

export class InvalidLocalAiModelError extends Error {
  constructor(received: string | undefined) {
    super(
      `Invalid Local AI model identifier: ${
        received === undefined || received === ''
          ? '<empty>'
          : JSON.stringify(received)
      }. Expected the canonical persisted form 'local-ai/<modelId>'.`,
    );
    this.name = 'InvalidLocalAiModelError';
  }
}

export function parseLocalAiModel(model: string): string {
  if (!model) throw new InvalidLocalAiModelError(model);
  const idx = model.indexOf('/');
  if (idx < 0) throw new InvalidLocalAiModelError(model);
  const prefix = model.slice(0, idx);
  const tail = model.slice(idx + 1);
  if (prefix !== 'local-ai' || tail.length === 0) throw new InvalidLocalAiModelError(model);
  return tail;
}

interface QueryInstance extends AsyncIterable<SDKMessage> {
  [key: string]: unknown;
}

async function* streamUnified(
  queryInstance: QueryInstance,
  resolveSessionId: (id: string) => void,
): AsyncGenerator<UnifiedMessage, void, unknown> {
  let providerSessionId: string | null = null;
  for await (const sdkMessage of queryInstance) {
    const raw = sdkMessage as unknown as Record<string, unknown>;
    const sid = raw.session_id;
    if (typeof sid === 'string' && providerSessionId === null) {
      providerSessionId = sid;
      resolveSessionId(sid);
    }
    for (const unified of mapMessage(sdkMessage, providerSessionId)) {
      yield unified;
    }
  }
}

export class LocalAiProvider implements LlmProvider {
  readonly name = 'local-ai' as const;

  getCapabilities(): ProviderCapabilities {
    return getCapabilities('local-ai');
  }

  async startTurn(options: ProviderRunOptions): Promise<ProviderRunResult> {
    const abortController = options.abortController ?? new AbortController();
    const bareModel = parseLocalAiModel(options.model);

    const sdkOptions = mapOptionsToSDK({
      cwd: options.cwd,
      sessionId: options.resumeSessionId ?? undefined,
      ...(options.permissionMode !== undefined
        ? { permissionMode: options.permissionMode as never }
        : {}),
      ...(options.customSystemPrompt !== undefined
        ? { customSystemPrompt: options.customSystemPrompt }
        : {}),
      systemPromptAppend: LOCAL_AI_CONCISENESS_NOTE,
      ...(options.env !== undefined ? { env: options.env } : {}),
      model: bareModel,
      effort: options.effort,
      ...(options.disallowedTools !== undefined
        ? { disallowedTools: options.disallowedTools }
        : {}),
    });

    const prompt = options.prompt;
    async function* promptStream() {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      };
    }

    const queryInstance = query({
      prompt: promptStream() as never,
      options: { ...sdkOptions, abortController } as never,
    }) as unknown as QueryInstance;

    let resolveSessionId!: (id: string) => void;
    const providerSessionId$ = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    const pidFromSdk =
      (queryInstance as { _processPid?: number; pid?: number })._processPid ??
      (queryInstance as { pid?: number }).pid ??
      null;

    return {
      events: streamUnified(queryInstance, resolveSessionId),
      providerSessionId$,
      abort: () => abortController.abort(),
      pid: typeof pidFromSdk === 'number' ? pidFromSdk : null,
    };
  }

  async sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult> {
    return this.startTurn({ ...options, resumeSessionId: options.resumeSessionId });
  }

  async loadTranscript(options: LoadTranscriptOptions): Promise<UnifiedMessage[]> {
    const entries = await loadAnthropicTranscript(options);
    return entries.map((e) => ({ ...e, provider: 'local-ai' as const }));
  }

  abortTurn(providerSessionId: string): boolean {
    const active = activeSessions.get(providerSessionId);
    if (!active) return false;
    const linked = agentRunsDb.getByConversationId(active.conversationId);
    if (linked && linked.status === 'running') {
      agentRunsDb.updateStatus(linked.id, 'failed');
    }
    active.abortController.abort();
    active.status = 'aborted';
    return true;
  }
}

export const localAiProvider = new LocalAiProvider();
