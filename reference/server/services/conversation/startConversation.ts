// Public conversation orchestrators: `startConversation` (new task conversation)
// and `sendMessage` (resume an existing conversation). Both share the unified
// streaming loop in `runStreamingLoop.ts` and compose lifecycle hooks via
// `composeAsync`.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import { conversationsDb, tasksDb, agentRunsDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { getGitHubToken } from '../githubCredentials.js';
import { generateConversationTitle } from '../titleGenerator.js';
import {
  auditClaudeLaunch,
  buildClaudeSdkEnv,
  ensureFreshClaudeToken,
  getQueryProcessPid,
  refreshClaudeOAuthToken,
} from '../claudeCredentials.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { resolveSlashCommand } from './slashCommands.js';
import { handleVideoRecording, handleImages, cleanupTempFiles } from './media.js';
import { ThinkingAccumulator, patchThinking } from './thinkingPatcher.js';
import {
  validateAndNormalizeOptions,
  mapOptionsToSDK,
  loadMcpConfig,
} from './sdkOptions.js';
import { injectVideoRecording, waitForMcpServers } from './mcpReadiness.js';
import { activeSessions } from './sessionState.js';
import { buildCanUseTool, rejectPendingAskUserQuestion } from './askUserQuestion.js';
import {
  handleStreamingStarted,
  handleStreamingComplete,
  composeAsync,
} from './streamingLifecycle.js';
import { buildAgentRunCompletionHandler, failLinkedAgentRunIfRunning } from './agentRunLifecycle.js';
import { runStreamingLoop } from './runStreamingLoop.js';
import {
  isClaudeAuthError,
  isOutputTokenLimitError,
  TOKEN_LIMIT_CONTINUATION_PROMPT,
  MAX_TOKEN_LIMIT_RETRIES,
  delay,
  AUTH_RETRY_BACKOFF_MS,
} from './retryOn401.js';
import { startCodexConversation, sendCodexMessage } from './startCodexConversation.js';
import {
  startOpenCodeConversation,
  sendOpenCodeMessage,
} from './startOpenCodeConversation.js';
import { buildOllamaSdkEnv, readOllamaContextWindow, readOllamaUrl, readOllamaInstances } from '../ollamaCredentials.js';
import { parseOllamaModel } from '../providers/ollama/index.js';
import { buildLocalAiSdkEnv, readLocalAiContextWindow, readLocalAiUrl, readLocalAiDisableProxy, readLocalAiInstances } from '../localAiCredentials.js';
import { parseLocalAiModel } from '../providers/local-ai/index.js';
import { ensureLocalAiProxy } from '../localAiProxy.js';
import { localAiPool, ollamaPool } from '../instancePool.js';
import { sqliteSessionStore, createTruncatingSessionStore } from '../sqliteSessionStore.js';
import type { ConversationOptions, StreamingContext } from './types.js';

/**
 * Compose the streaming-complete handlers: universal broadcast + map cleanup,
 * then agent-run-aware status update / chaining / push notification.
 *
 * Neither handler takes an isError argument anymore — failure is recorded
 * separately on the agent_run row by `abortSession` (user-Stop) or
 * the server-startup orphan recovery, not derived from a boolean threaded
 * through the streaming loop.
 */
function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    () => handleStreamingComplete(ctx),
    buildAgentRunCompletionHandler(ctx),
  );
}

/**
 * Start a new conversation for a task.
 */
export async function startConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  // Provider dispatch. The Anthropic path is the original body of this
  // function — preserved verbatim below. The 'openai' path lives in
  // `startCodexConversation.ts` and only re-uses provider-agnostic
  // pieces (streaming lifecycle, agent-run completion handler).
  if (options.provider === 'openai') {
    return startCodexConversation(taskId, message, options);
  }
  if (options.provider === 'opencode') {
    return startOpenCodeConversation(taskId, message, options);
  }

  const normalizedOptions = validateAndNormalizeOptions(options, 'startConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
    permissionMode,
    images,
    customSystemPrompt,
    videoConfig,
  } = normalizedOptions;

  // Every conversation runs on an explicit model — resolved from the chosen
  // settings by the caller (route / agentRunner). No SDK default, ever.
  const model = normalizedOptions.model;
  const effort = normalizedOptions.effort ?? null;
  if (!model) {
    throw new Error('startConversation requires an explicit model');
  }

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Prefer the caller-supplied path (agentRunner resolves the worktree once
  // before calling us, so we don't re-check and risk a race).
  let projectPath: string;
  if (options.projectPath) {
    projectPath = options.projectPath;
  } else {
    projectPath = taskWithProject.repo_folder_path;
    if (await worktreeExists(projectPath, taskId)) {
      projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
    }
  }

  const isOllama = options.provider === 'ollama';
  const isLocalAi = options.provider === 'local-ai';
  let sdkModel = model;
  let sdkEnv: Record<string, string | undefined>;
  if (isOllama) {
    sdkModel = parseOllamaModel(model);
    let assignedOllamaUrl: string;
    if (options.instanceUrl) {
      assignedOllamaUrl = options.instanceUrl;
    } else {
      const ollamaInstances = readOllamaInstances(userId);
      ollamaPool.setInstances(ollamaInstances.map((i) => i.url));
      assignedOllamaUrl = ollamaPool.acquire(taskId ?? 0) ?? readOllamaUrl(userId).url;
    }
    sdkEnv = buildOllamaSdkEnv(userId, assignedOllamaUrl);
  } else if (isLocalAi) {
    sdkModel = parseLocalAiModel(model);
    let assignedLocalAiUrl: string;
    if (options.instanceUrl) {
      assignedLocalAiUrl = options.instanceUrl;
    } else {
      const localAiInstances = readLocalAiInstances(userId);
      localAiPool.setInstances(localAiInstances.map((i) => i.url));
      assignedLocalAiUrl = localAiPool.acquire(taskId ?? 0) ?? readLocalAiUrl(userId).url;
    }
    await ensureLocalAiProxy(assignedLocalAiUrl, readLocalAiDisableProxy(userId));
    sdkEnv = buildLocalAiSdkEnv(userId, assignedLocalAiUrl);
  } else {
    await ensureFreshClaudeToken(userId);
    sdkEnv = buildClaudeSdkEnv(userId);
  }

  // Inject GH_TOKEN so agents can use gh CLI without manual auth
  const ghToken = userId != null ? getGitHubToken(userId, taskWithProject.project_id) : null;
  if (ghToken) {
    sdkEnv = { ...sdkEnv, GH_TOKEN: ghToken };
  }

  let conversationId = options.conversationId;
  if (!conversationId) {
    const providerForRow = isOllama ? 'ollama' : isLocalAi ? 'local-ai' : 'anthropic';
    const conversation = conversationsDb.create(taskId, providerForRow, model, effort);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created conversation ${conversationId} for task ${taskId} (provider=${providerForRow}, model=${model})`,
    );
  }

  const abortController = new AbortController();

  const sdkOptions = mapOptionsToSDK({
    cwd: projectPath,
    permissionMode,
    customSystemPrompt,
    model: sdkModel,
    effort,
    disallowedTools: normalizedOptions.disallowedTools,
    env: sdkEnv,
    canUseTool: buildCanUseTool({
      conversationId,
      broadcastFn,
      taskId,
      broadcastToTaskSubscribersFn,
    }),
  });

  // Local inference servers (Ollama, local-ai) don't support extended thinking
  // or partial-message streaming — sending these params causes a 400 error
  // that kills the subprocess before a session_id is ever emitted.
  if (isOllama || isLocalAi) {
    delete (sdkOptions as Record<string, unknown>).thinking;
    delete (sdkOptions as Record<string, unknown>).includePartialMessages;
  }

  let mcpServers = await loadMcpConfig(projectPath);
  if (mcpServers && videoConfig) {
    mcpServers = (injectVideoRecording(mcpServers as never, videoConfig) ?? null);
  }
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  const imageResult = await handleImages(message, images, projectPath);
  let finalMessage: string | null = imageResult.modifiedCommand;
  const { tempImagePaths, tempDir } = imageResult;

  finalMessage = await resolveSlashCommand(finalMessage, projectPath);

  // Deferred prompt: start the CLI subprocess first so MCP servers begin
  // connecting, wait for them to be ready, then deliver the user message.
  // Ensures Claude's first turn has all MCP tools available.
  let releaseFn: () => void = () => {};
  const mcpReady = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  async function* deferredPrompt() {
    await mcpReady;
    yield {
      type: 'user',
      message: { role: 'user', content: finalMessage },
      parent_tool_use_id: null,
    };
  }

  const queryInstance = query({
    prompt: deferredPrompt() as never,
    options: { ...sdkOptions, abortController } as never,
  });
  auditClaudeLaunch({
    source: 'startConversation',
    userId,
    pid: getQueryProcessPid(queryInstance),
    conversationId,
    claudeSessionId: null,
    cwd: projectPath,
  });

  // Always release, even on timeout.
  void waitForMcpServers(queryInstance).finally(() => releaseFn());

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Session creation timeout'));
    }, 60000);

    const thinkingAcc = new ThinkingAccumulator();
    const ctx: StreamingContext = {
      conversationId: conversationId,
      taskId,
      claudeSessionId: null,
      userId,
      broadcastFn,
      broadcastToTaskSubscribersFn,
      isNewSession: true,
      videoConfig,
    };
    const contextUsageTracker = createContextUsageTracker({
      conversationId: conversationId,
      broadcastFn,
    });

    const onSessionId = async (sid: string) => {
      ctx.claudeSessionId = sid;
      clearTimeout(timeout);

      activeSessions.set(sid, {
        instance: queryInstance,
        abortController,
        startTime: Date.now(),
        status: 'active',
        tempImagePaths,
        tempDir,
        conversationId,
        taskId,
        projectId: taskWithProject.project_id,
        userId: userId ?? null,
      });

      conversationsDb.updateClaudeId(conversationId, sid);
      // Provider-agnostic session id: for Anthropic conversations this just
      // duplicates claude_conversation_id. Codex conversations (Phase 9)
      // write only this column.
      conversationsDb.updateProviderSessionId(conversationId, sid);
      // session_path stores the cwd we passed to the SDK so the read path can
      // recover the canonical projectKey (worktree paths and repo paths produce
      // different projectKeys; without this we'd miss sessions started inside
      // worktrees).
      conversationsDb.updateSessionPath(conversationId, projectPath);
      console.log(`[ConversationAdapter] Updated conversation ${conversationId} with session ${sid}`);

      // Fire-and-forget AI title generation. Dual-emits the rename on the
      // conversation channel (chat header) and task channel (task viewer's
      // conversation list).
      generateConversationTitle(
        conversationId,
        message,
        broadcastFn,
        userId,
        taskId,
        broadcastToTaskSubscribersFn,
      );

      handleStreamingStarted(ctx);

      if (broadcastFn) {
        broadcastFn(conversationId, {
          type: 'conversation-created',
          conversationId: conversationId,
          claudeSessionId: sid,
        });
      }

      if (broadcastToTaskSubscribersFn) {
        broadcastToTaskSubscribersFn(taskId, {
          type: 'conversation-added',
          conversation: {
            id: conversationId,
            task_id: taskId,
            claude_conversation_id: sid,
            created_at: new Date().toISOString(),
          },
        });
      }

      resolve({ conversationId: conversationId, claudeSessionId: sid });
    };

    void (async () => {
      try {
        const { authError, resultIsError } = await runStreamingLoop({
          queryInstance: queryInstance as never,
          conversationId: conversationId,
          broadcastFn,
          thinkingAcc,
          contextUsageTracker,
          initialSessionId: null,
          onSessionId,
          broadcastClaudeStatus: true,
          // Force the SDK subprocess to exit after `result`; otherwise a
          // background bash the agent left running (intentional or
          // `assistantAutoBackgrounded`) keeps the iterator open and this
          // loop never returns. runStreamingLoop swallows the resulting
          // abort error so we still reach the success path below.
          onResult: () => abortController.abort(),
          // Ollama: mirror messages to sqliteSessionStore manually because
          // the Claude CLI does not create JSONL files for non-Anthropic
          // sessions (no server-side session to anchor the file name to).
          ollamaProjectKey: (isOllama || isLocalAi) ? projectPath.replace(/\//g, '-') : undefined,
        });

        // In-band 401: the SDK delivered the auth failure as data instead
        // of throwing. Synthesise the equivalent throw so the existing
        // catch-block recovery path (subprocess recycle + transparent
        // retry) runs uniformly for both representations.
        if (authError) {
          throw new Error(
            'Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials',
          );
        }

        // Non-auth in-band error (e.g. a 400 "exceeds the available context
        // size" from Ollama/local-ai): the loop ended without throwing, so
        // pre-mark the linked agent run 'failed' before composeOnComplete
        // runs below — otherwise it would see status='running' and silently
        // mark this 'completed', chaining to the next agent on a turn that
        // never actually produced anything.
        if (resultIsError) {
          failLinkedAgentRunIfRunning(taskId, conversationId);
        }

        // If the subprocess exited without ever emitting a session_id,
        // the provider failed before starting (e.g. Ollama not running,
        // model not found, bad env). Mark the agent run failed immediately
        // and reject the outer promise rather than silently completing.
        if (!ctx.claudeSessionId) {
          const linkedRun = agentRunsDb.getByConversationId(conversationId);
          if (linkedRun && linkedRun.status === 'running') {
            agentRunsDb.updateStatus(linkedRun.id, 'failed');
            if (broadcastToTaskSubscribersFn && taskId) {
              broadcastToTaskSubscribersFn(taskId, {
                type: 'agent-run-updated',
                agentRun: {
                  id: linkedRun.id,
                  status: 'failed',
                  agent_type: linkedRun.agent_type as never,
                  conversation_id: conversationId,
                  created_at: linkedRun.created_at,
                  completed_at: linkedRun.completed_at,
                },
              });
            }
          }
          if (broadcastFn) {
            broadcastFn(conversationId, {
              type: 'claude-error',
              error:
                isOllama
                  ? 'Ollama subprocess exited without starting a session. Check that Ollama is running (`ollama serve`) and the selected model exists (`ollama list`).'
                  : isLocalAi
                    ? 'Local AI subprocess exited without starting a session. Check that your local AI server is running and the selected model is loaded.'
                    : 'The LLM subprocess exited without starting a session.',
            });
          }
          clearTimeout(timeout);
          reject(
            new Error(
              isOllama
                ? 'Ollama not reachable or model not found — check `ollama serve` and `ollama list`'
                : isLocalAi
                  ? 'Local AI server not reachable or model not loaded'
                  : 'LLM subprocess exited without establishing a session',
            ),
          );
          return;
        }

        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }

        await cleanupTempFiles(tempImagePaths, tempDir);
        await patchThinking(ctx.claudeSessionId, projectPath, userId, thinkingAcc);

        if (ctx.videoConfig) {
          await handleVideoRecording(ctx.videoConfig);
        }

        if (broadcastFn) {
          broadcastFn(conversationId, {
            type: 'claude-complete',
            sessionId: ctx.claudeSessionId,
            exitCode: 0,
            isNewSession: true,
          });
        }

        await composeOnComplete(ctx)();
      } catch (error) {
        console.error('[ConversationAdapter] Streaming error:', error);

        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);

        if (ctx.videoConfig?.tempDir) {
          await fs.rm(ctx.videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
        }

        if (!ctx.claudeSessionId) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        // Subprocess auth credential aged out mid-stream: try refreshing the
        // OAuth token first, then resume in a fresh subprocess.
        // Don't broadcast claude-error — keep it transparent.
        if (isClaudeAuthError(error) && !normalizedOptions.isAuthRetry) {
          console.warn(
            `[ConversationAdapter] Auth 401 on conversation ${conversationId} — attempting token refresh then recycling subprocess`,
          );
          try {
            await refreshClaudeOAuthToken(userId);
            console.log(`[ConversationAdapter] Token refreshed for user ${userId} after 401`);
          } catch (refreshErr) {
            const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            console.warn(`[ConversationAdapter] Token refresh failed: ${msg}`);
          }
          await delay(AUTH_RETRY_BACKOFF_MS);
          try {
            await sendMessage(conversationId, message, { ...options, isAuthRetry: true });
          } catch {
            // sendMessage already broadcast claude-error + ran composeOnComplete().
          }
          return;
        }

        // Output-token limit hit mid-response: the partial output is already
        // persisted in the session store. Resume transparently with a
        // continuation prompt so the agent finishes its work without any
        // human intervention.
        {
          const retryCount = normalizedOptions.tokenLimitRetryCount ?? 0;
          if (isOutputTokenLimitError(error) && retryCount < MAX_TOKEN_LIMIT_RETRIES) {
            console.warn(
              `[ConversationAdapter] Output token limit hit on conversation ${conversationId} — resuming automatically (attempt ${retryCount + 1}/${MAX_TOKEN_LIMIT_RETRIES})`,
            );
            try {
              await sendMessage(conversationId, TOKEN_LIMIT_CONTINUATION_PROMPT, {
                ...options,
                tokenLimitRetryCount: retryCount + 1,
              });
            } catch {
              // sendMessage already broadcast claude-error + ran composeOnComplete().
            }
            return;
          }
        }

        if (broadcastFn) {
          const errMsg = error instanceof Error ? error.message : String(error);
          broadcastFn(conversationId, {
            type: 'claude-error',
            error: errMsg,
          });
        }

        // A genuine, unrecovered streaming error reached this point (not
        // handled by the auth-retry or token-limit-retry paths above, which
        // both `return` before here). Pre-mark the agent run 'failed' so
        // composeOnComplete's "status === 'failed' → no-op, don't chain"
        // branch fires instead of silently marking it 'completed' and
        // chaining to the next agent on a broken turn.
        failLinkedAgentRunIfRunning(taskId, conversationId);
        await composeOnComplete(ctx)();
      } finally {
        rejectPendingAskUserQuestion(conversationId, 'streaming ended');
      }
    })();
  });
}

/**
 * Send a message to an existing conversation (resume).
 */
export async function sendMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  // Provider dispatch on resume. Resolve the provider off the existing
  // conversation row rather than trusting options — a resume hits the
  // same backend that created the session. Explicit options.provider
  // (passed by agentRunner) is the override.
  const conversationForProvider = conversationsDb.getById(conversationId);
  if (!conversationForProvider) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  // The row's provider is the source of truth on resume (NOT NULL column);
  // an explicit options.provider override only matters for internal callers.
  const resolvedProvider = options.provider ?? conversationForProvider.provider;
  if (resolvedProvider === 'openai') {
    return sendCodexMessage(conversationId, message, options);
  }
  if (resolvedProvider === 'opencode') {
    return sendOpenCodeMessage(conversationId, message, options);
  }

  const normalizedOptions = validateAndNormalizeOptions(options, 'sendMessage');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
    images,
    permissionMode,
    askUserQuestionToolResult,
  } = normalizedOptions;

  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  // Resume runs on an explicit model+effort — never the SDK's silent default.
  // Re-resolve from the RESUMING user's per-user agent settings (same provider
  // only; provider is session-bound), falling back to the row's stamped value.
  // Explicit options on the call still win (internal callers only).
  const userOverride = resolveResumeModelEffort(conversation, userId);
  const resumeModel = normalizedOptions.model ?? userOverride.model;
  const resumeEffort = normalizedOptions.effort ?? userOverride.effort;
  if (!resumeModel) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  // Keep the row authoritative for later turns when this turn's resolved
  // model/effort differs from what was stamped.
  if (resumeModel !== conversation.model || resumeEffort !== conversation.effort) {
    conversationsDb.updateModelEffort(conversationId, resumeModel, resumeEffort);
  }

  if (!conversation.claude_conversation_id) {
    throw new Error(`Conversation ${conversationId} has no Claude session ID yet`);
  }

  const claudeSessionId = conversation.claude_conversation_id;
  const taskId = conversation.task_id;

  // Always resolve the parent task so we can stamp `projectId` onto the
  // ActiveSession entry — WS auth (`abort-session`,
  // `check-session-status`, `get-active-sessions`) and the filtered
  // `/api/streaming-sessions` REST endpoint depend on it.
  if (!taskId) {
    throw new Error(`Conversation ${conversationId} has no task_id`);
  }
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }
  const projectId = taskWithProject.project_id;

  let projectPath: string;

  // Prefer the stored session_path so worktree-started sessions resume in the
  // same cwd.
  if (conversation.session_path) {
    projectPath = conversation.session_path;
  } else {
    projectPath = taskWithProject.repo_folder_path;

    if (await worktreeExists(projectPath, taskId)) {
      projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
    }
  }

  const abortController = new AbortController();
  const isOllamaResume = resolvedProvider === 'ollama';
  const isLocalAiResume = resolvedProvider === 'local-ai';
  let resumeSdkModel = resumeModel;
  let resumeEnv: Record<string, string | undefined>;
  if (isOllamaResume) {
    resumeSdkModel = parseOllamaModel(resumeModel);
    const ollamaInstances = readOllamaInstances(userId);
    ollamaPool.setInstances(ollamaInstances.map((i) => i.url));
    const assignedOllamaUrl = ollamaPool.getUrl(taskId) ?? ollamaPool.acquire(taskId) ?? readOllamaUrl(userId).url;
    resumeEnv = buildOllamaSdkEnv(userId, assignedOllamaUrl);
  } else if (isLocalAiResume) {
    resumeSdkModel = parseLocalAiModel(resumeModel);
    const localAiInstances = readLocalAiInstances(userId);
    localAiPool.setInstances(localAiInstances.map((i) => i.url));
    const assignedLocalAiUrl = localAiPool.getUrl(taskId) ?? localAiPool.acquire(taskId) ?? readLocalAiUrl(userId).url;
    await ensureLocalAiProxy(assignedLocalAiUrl, readLocalAiDisableProxy(userId));
    resumeEnv = buildLocalAiSdkEnv(userId, assignedLocalAiUrl);
  } else {
    await ensureFreshClaudeToken(userId);
    resumeEnv = buildClaudeSdkEnv(userId);
  }

  // Inject GH_TOKEN so agents can use gh CLI without manual auth
  const resumeGhToken = userId != null ? getGitHubToken(userId, projectId) : null;
  if (resumeGhToken) {
    resumeEnv = { ...resumeEnv, GH_TOKEN: resumeGhToken };
  }

  // Local models' real context windows are far smaller than the SDK's native
  // auto-compact floor (100k tokens, unusable below that). Truncate the
  // resumed history ourselves so it stays under the user-configured budget
  // instead of hitting a 400 "exceeds available context size" from the server.
  let resumeSessionStore = sqliteSessionStore;
  if (isOllamaResume) {
    resumeSessionStore = createTruncatingSessionStore(sqliteSessionStore, readOllamaContextWindow(userId));
  } else if (isLocalAiResume) {
    resumeSessionStore = createTruncatingSessionStore(sqliteSessionStore, readLocalAiContextWindow(userId));
  }

  // Resume reads transcripts from sqliteSessionStore.load() — no per-user
  // CLAUDE_CONFIG_DIR materialization required.
  const sdkOptions = mapOptionsToSDK({
    cwd: projectPath,
    sessionId: claudeSessionId,
    permissionMode,
    env: resumeEnv,
    canUseTool: buildCanUseTool({
      conversationId,
      broadcastFn,
      taskId,
      broadcastToTaskSubscribersFn,
    }),
    model: resumeSdkModel,
    effort: resumeEffort,
    sessionStore: resumeSessionStore,
  });

  // Local inference servers don't support extended thinking or partial-message
  // streaming — sending these params causes a 400 error.
  if (isOllamaResume || isLocalAiResume) {
    delete (sdkOptions as Record<string, unknown>).thinking;
    delete (sdkOptions as Record<string, unknown>).includePartialMessages;
  }

  const mcpServers = await loadMcpConfig(projectPath);
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  // Skip image handling when sending a synthesised tool_result for an orphan
  // AskUserQuestion — there's no user text to attach images to.
  const imageResult = askUserQuestionToolResult
    ? { modifiedCommand: null as string | null, tempImagePaths: [], tempDir: null }
    : await handleImages(message, images, projectPath);
  let finalMessage: string | null = imageResult.modifiedCommand;
  const { tempImagePaths, tempDir } = imageResult;

  if (!askUserQuestionToolResult) {
    finalMessage = await resolveSlashCommand(finalMessage, projectPath);
  }

  const ctx: StreamingContext = {
    conversationId,
    taskId,
    claudeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    isNewSession: false,
  };

  handleStreamingStarted(ctx);

  // Deferred prompt: wait for MCP servers before delivering the user message.
  // When askUserQuestionToolResult is set, yield a tool_result block instead
  // of plain text — Anthropic's API requires this whenever the previous
  // assistant turn ended with a tool_use that had no matching tool_result.
  let releaseFn: () => void = () => {};
  const mcpReady = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  async function* deferredPrompt() {
    await mcpReady;
    if (askUserQuestionToolResult) {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: askUserQuestionToolResult.tool_use_id,
              content: askUserQuestionToolResult.content,
            },
          ],
        },
        parent_tool_use_id: null,
      };
      return;
    }
    yield {
      type: 'user',
      message: { role: 'user', content: finalMessage },
      parent_tool_use_id: null,
    };
  }

  const queryInstance = query({
    prompt: deferredPrompt() as never,
    options: { ...sdkOptions, abortController } as never,
  });
  auditClaudeLaunch({
    source: 'sendMessage',
    userId,
    pid: getQueryProcessPid(queryInstance),
    conversationId,
    claudeSessionId,
    cwd: projectPath,
  });

  void waitForMcpServers(queryInstance).finally(() => releaseFn());

  activeSessions.set(claudeSessionId, {
    instance: queryInstance,
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    conversationId,
    taskId,
    projectId,
    userId: userId ?? null,
  });

  const thinkingAcc = new ThinkingAccumulator();
  const contextUsageTracker = createContextUsageTracker({ conversationId, broadcastFn });

  try {
    const { authError, resultIsError } = await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId,
      broadcastFn,
      thinkingAcc,
      contextUsageTracker,
      initialSessionId: claudeSessionId,
      broadcastClaudeStatus: false,
      // See the matching comment in startConversation: abort the SDK
      // subprocess after `result` so a leftover background bash can't pin
      // the iterator open. runStreamingLoop swallows the abort error.
      onResult: () => abortController.abort(),
      // Ollama: same manual mirror as startConversation.
      ollamaProjectKey: (isOllamaResume || isLocalAiResume) ? projectPath.replace(/\//g, '-') : undefined,
    });

    // In-band 401: see matching comment in startConversation.
    if (authError) {
      throw new Error(
        'Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials',
      );
    }

    // Non-auth in-band error (e.g. context-overflow on resume — the exact
    // case this is fixing for): see matching comment in startConversation.
    if (resultIsError) {
      failLinkedAgentRunIfRunning(taskId, conversationId);
    }

    activeSessions.delete(claudeSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);
    await patchThinking(claudeSessionId, projectPath, userId, thinkingAcc);

    if (broadcastFn) {
      broadcastFn(conversationId, {
        type: 'claude-complete',
        sessionId: claudeSessionId,
        exitCode: 0,
        isNewSession: false,
      });
    }

    await composeOnComplete(ctx)();
  } catch (error) {
    console.error('[ConversationAdapter] Resume streaming error:', error);

    activeSessions.delete(claudeSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Subprocess auth credential aged out mid-stream: try refreshing the
    // OAuth token, then resume in a fresh subprocess. Skip for
    // AskUserQuestion-resume turns — re-driving a tool_result is fiddly.
    if (isClaudeAuthError(error) && !normalizedOptions.isAuthRetry && !askUserQuestionToolResult) {
      console.warn(
        `[ConversationAdapter] Auth 401 on conversation ${conversationId} — attempting token refresh then recycling subprocess`,
      );
      try {
        await refreshClaudeOAuthToken(userId);
        console.log(`[ConversationAdapter] Token refreshed for user ${userId} after 401`);
      } catch (refreshErr) {
        const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        console.warn(`[ConversationAdapter] Token refresh failed: ${msg}`);
      }
      await delay(AUTH_RETRY_BACKOFF_MS);
      return await sendMessage(conversationId, message, { ...options, isAuthRetry: true });
    }

    // Output-token limit hit mid-response: partial output is already persisted.
    // Resume automatically so the agent reaches completion without intervention.
    {
      const retryCount = normalizedOptions.tokenLimitRetryCount ?? 0;
      if (isOutputTokenLimitError(error) && retryCount < MAX_TOKEN_LIMIT_RETRIES && !askUserQuestionToolResult) {
        console.warn(
          `[ConversationAdapter] Output token limit hit on conversation ${conversationId} — resuming automatically (attempt ${retryCount + 1}/${MAX_TOKEN_LIMIT_RETRIES})`,
        );
        return await sendMessage(conversationId, TOKEN_LIMIT_CONTINUATION_PROMPT, {
          ...options,
          tokenLimitRetryCount: retryCount + 1,
        });
      }
    }

    if (broadcastFn) {
      const errMsg = error instanceof Error ? error.message : String(error);
      broadcastFn(conversationId, {
        type: 'claude-error',
        error: errMsg,
      });
    }

    // A genuine, unrecovered streaming error reached this point (the
    // auth-retry and token-limit-retry paths above both `return` before
    // here). Pre-mark the agent run 'failed' so the completion handler
    // below doesn't silently mark it 'completed' and chain on a broken turn.
    failLinkedAgentRunIfRunning(taskId, conversationId);
    await composeOnComplete(ctx)();

    throw error;
  } finally {
    rejectPendingAskUserQuestion(conversationId, 'streaming ended');
  }
}
