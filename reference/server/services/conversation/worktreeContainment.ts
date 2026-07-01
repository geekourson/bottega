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

// Bash is the OTHER escape hatch, and the one that bit us in production: gating
// only Edit/Write/MultiEdit/NotebookEdit left the model free to `cd
// /…/<repo> && cp worktree/src/x /…/<repo>/src/x` (observed verbatim on
// task-64, local model), or `git reset`/`rm` inside main — none of which the
// edit-tool gate sees. We can't fully parse arbitrary shell, but the corruption
// vector is always the same: the command names the MAIN repo path explicitly
// (its cwd is already the worktree, so it never needs to). We deny any Bash
// command that references the main repo root — or a SIBLING task's worktree —
// by absolute path. References that stay inside this task's own worktree pass.
const REPO_TOOL_PATHS: Record<string, string> = {
  ...FILE_MUTATING_TOOL_PATHS,
  Bash: 'command',
};

/** Chars that terminate a path token on a shell command line. */
function isPathBoundary(ch: string): boolean {
  return ch === '' || /[\s"'`;&|()<>]/.test(ch);
}

/**
 * True when a Bash `command` string references the MAIN repo (or another task's
 * worktree) by absolute path — i.e. escapes this task's worktree. The worktree
 * root is always `${repo}-worktrees/${name}`, so the main repo root is derived
 * by stripping that suffix. Every occurrence of the repo root in the command is
 * inspected: a reference that continues into THIS worktree is allowed; a bare
 * main-repo reference (`<repo>`, `<repo>/…`, `cd <repo> && …`) or a sibling
 * worktree is denied. Relative escapes (`cd ..`) are not covered here — the
 * cwd is the worktree and models overwhelmingly reach for absolute paths.
 */
export function bashCommandEscapesWorktree(worktreeRoot: string, command: string): boolean {
  if (!command) return false;
  const wt = path.resolve(worktreeRoot);
  const worktreesDir = path.dirname(wt); // `${repo}-worktrees`
  if (!worktreesDir.endsWith('-worktrees')) return false; // unexpected layout — don't over-block
  const repoRoot = worktreesDir.slice(0, -'-worktrees'.length); // `${repo}`

  // True when a path token that started earlier ends at position `pos` — i.e.
  // `pos` sits on a separator, a shell boundary char, or end-of-string.
  const tokenEndsAt = (pos: number): boolean => {
    const ch = command.charAt(pos); // '' at end
    return ch === '' || ch === path.sep || isPathBoundary(ch);
  };

  for (let i = command.indexOf(repoRoot); i !== -1; i = command.indexOf(repoRoot, i + 1)) {
    const next = command.charAt(i + repoRoot.length); // '' at end
    // Direct main-repo reference: `<repo>`, `<repo>/…`, `cd <repo> &&`.
    if (next === '' || next === path.sep || isPathBoundary(next)) return true;
    // Worktrees area (`<repo>-worktrees/…`): allowed ONLY if it is THIS task's
    // worktree, bounded so `task-6` doesn't match `task-64`.
    if (command.startsWith('-worktrees', i + repoRoot.length)) {
      const isOwnWorktree = command.startsWith(wt, i) && tokenEndsAt(i + wt.length);
      if (!isOwnWorktree) return true; // a sibling task's worktree
    }
    // Otherwise a different path that merely shares the prefix (e.g.
    // `<repo>-backup`) — not our concern.
  }
  return false;
}

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

/** Deny reason for a Bash command that reaches outside the worktree. */
export function bashEscapeMessage(worktreeRoot: string): string {
  return (
    `This task is isolated to its git worktree at ${worktreeRoot}, which is already your ` +
    `working directory. The blocked command referenced the MAIN repository (or another task's ` +
    `worktree) by absolute path. Never cd into, cp/mv into, or run git/rm against the main repo: ` +
    `your changes stay in this worktree and are merged later via pull request. Re-run the command ` +
    `using paths inside ${worktreeRoot} (or plain relative paths from the current directory).`
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

    // Bash: block commands that name the main repo (or a sibling worktree) by
    // absolute path — the `cp`/`cd`/`git`/`rm`-into-main escape hatch that the
    // edit-tool gate can't see.
    if (toolName === 'Bash') {
      const command = input?.tool_input?.command;
      if (typeof command !== 'string' || !bashCommandEscapesWorktree(worktreeRoot, command)) {
        return {};
      }
      console.warn(
        `[Worktree] Blocked Bash command reaching outside worktree ${worktreeRoot}: ${command.slice(0, 200)}`,
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: bashEscapeMessage(worktreeRoot),
        },
      };
    }

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
        matcher: Object.keys(REPO_TOOL_PATHS).join('|'),
        hooks: [preToolUse],
      },
    ],
  };
}
