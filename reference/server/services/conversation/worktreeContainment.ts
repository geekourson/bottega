// Hard worktree containment for file-mutating tools.
//
// Setting the SDK `cwd` to a task's worktree is NOT enough to keep an agent on
// its own branch: the model can still reach into the main repository via an
// ABSOLUTE path (e.g. after Read-ing a main-repo file, it Edits that same
// absolute path). Observed repeatedly in production — task-48's transcript
// issued `Edit /…/HyphoSphere/src/…` while its cwd was the worktree, corrupting
// `main` while several other tasks ran in parallel on their own worktrees.
//
// We previously enforced this inside the `canUseTool` callback. That callback,
// however, is NEVER invoked under `permissionMode: 'bypassPermissions'` (our
// default): the CLI auto-approves file edits and skips the `--permission-prompt-
// tool stdio` round-trip entirely. Empirically confirmed: under bypass, a Write
// reaches the tool with zero `canUseTool` calls.
//
// `PreToolUse` hooks, by contrast, run in EVERY permission mode (the hook input
// even carries `permission_mode`), and a `permissionDecision: 'deny'` actually
// blocks the tool. So containment lives here, as a hook — the only mechanism
// that fires under bypass.

import path from 'node:path';

// File-mutating tools mapped to the input field that carries their target path.
// Read is intentionally excluded — reading the main repo is harmless to
// isolation; only writes corrupt the main branch.
export const FILE_MUTATING_TOOL_PATHS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * True when `filePath` resolves outside the worktree root. Relative paths are
 * resolved against the worktree (matching the SDK cwd), so only absolute paths
 * that point elsewhere (typically the main repo) escape.
 */
export function pathEscapesWorktree(worktreeRoot: string, filePath: string): boolean {
  if (!filePath) return false;
  const root = path.resolve(worktreeRoot);
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  return abs !== root && !abs.startsWith(root + path.sep);
}

/** Human-readable deny reason fed back to the model so it retries inside the worktree. */
export function worktreeEscapeMessage(worktreeRoot: string, target: string): string {
  return (
    `This task is isolated to its git worktree at ${worktreeRoot}. ` +
    `The path "${target}" is OUTSIDE the worktree (it points at the main repository) and was blocked. ` +
    `Re-issue the operation against the matching file INSIDE the worktree — ` +
    `use a path relative to the current working directory, or replace the repository root with ${worktreeRoot}.`
  );
}

interface PreToolUseHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

interface PreToolUseDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/**
 * Build the `hooks` option enforcing worktree containment, or `undefined` when
 * enforcement is off (uses_worktree=0 tasks intentionally run on main).
 *
 * The returned object plugs straight into the SDK `query({ options: { hooks } })`.
 * A `PreToolUse` hook fires for every tool in every permission mode; we deny any
 * file-mutating tool whose target escapes the worktree and pass through the rest.
 */
export function buildWorktreeContainmentHooks(opts: {
  worktreeRoot?: string | undefined;
  enforceWorktree?: boolean | undefined;
}): Record<string, unknown> | undefined {
  const { worktreeRoot, enforceWorktree } = opts;
  if (!enforceWorktree || !worktreeRoot) return undefined;

  const preToolUse = async (
    input: PreToolUseHookInput,
  ): Promise<PreToolUseDenyOutput | Record<string, never>> => {
    const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
    const pathField = FILE_MUTATING_TOOL_PATHS[toolName];
    if (!pathField) return {};
    const target = input?.tool_input?.[pathField];
    if (typeof target !== 'string' || !pathEscapesWorktree(worktreeRoot, target)) {
      return {};
    }
    console.warn(
      `[Worktree] Blocked ${toolName} on "${target}" — outside worktree ${worktreeRoot}`,
    );
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: worktreeEscapeMessage(worktreeRoot, target),
      },
    };
  };

  return {
    PreToolUse: [
      {
        // Limit invocations to the tools we actually gate (regex on tool name).
        matcher: Object.keys(FILE_MUTATING_TOOL_PATHS).join('|'),
        hooks: [preToolUse],
      },
    ],
  };
}
