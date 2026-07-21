import { describe, it, expect } from 'vitest';
import {
  buildWorktreeContainmentHooks,
  pathEscapesWorktree,
  pathIsAllowlisted,
} from './worktreeContainment.js';

const WORKTREE = '/repos/HyphoSphere-worktrees/task-48';

// Extract the single PreToolUse callback the hooks object wires up.
function getHook(enforce = true, root: string | undefined = WORKTREE) {
  const hooks = buildWorktreeContainmentHooks({
    worktreeRoot: root,
    enforceWorktree: enforce,
  });
  const matchers = (hooks?.PreToolUse ?? []) as Array<{
    matcher?: string;
    hooks: Array<(input: unknown) => Promise<unknown>>;
  }>;
  return { hooks, matcher: matchers[0]?.matcher, cb: matchers[0]?.hooks[0] };
}

async function run(cb: ((input: unknown) => Promise<unknown>) | undefined, tool: string, fp?: string) {
  const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  return (await cb!({ tool_name: tool, tool_input: fp == null ? {} : { [field]: fp } })) as
    | { hookSpecificOutput?: { permissionDecision?: string } }
    | Record<string, never>;
}

function isDeny(out: { hookSpecificOutput?: { permissionDecision?: string } }): boolean {
  return out?.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('buildWorktreeContainmentHooks — PreToolUse enforcement (fires under bypassPermissions)', () => {
  it('returns undefined when enforcement is off (uses_worktree=0 → main allowed)', () => {
    expect(buildWorktreeContainmentHooks({ worktreeRoot: WORKTREE, enforceWorktree: false }))
      .toBeUndefined();
  });

  it('returns undefined when no worktree root is given', () => {
    expect(buildWorktreeContainmentHooks({ worktreeRoot: undefined, enforceWorktree: true }))
      .toBeUndefined();
  });

  it('registers a PreToolUse matcher scoped to the file-mutating tools', () => {
    const { matcher } = getHook();
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(matcher).toContain(tool);
    }
  });

  it('denies a Write whose absolute path points at the main repo', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'Write', '/repos/HyphoSphere/src/GameState.java'))).toBe(true);
  });

  it('denies an Edit that escapes the worktree', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'Edit', '/repos/HyphoSphere/src/SaveSystem.java'))).toBe(true);
  });

  it('denies a MultiEdit that escapes the worktree', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'MultiEdit', '/repos/HyphoSphere/src/PrestigeSystem.java'))).toBe(true);
  });

  it('denies a NotebookEdit (notebook_path) outside the worktree', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'NotebookEdit', '/repos/HyphoSphere/nb.ipynb'))).toBe(true);
  });

  it('surfaces the worktree path in the deny reason so the model can self-correct', async () => {
    const { cb } = getHook();
    const out = await run(cb, 'Edit', '/repos/HyphoSphere/src/GameState.java');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect((out.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason)
      .toContain(WORKTREE);
  });

  it('allows a Write with an absolute path inside the worktree', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'Write', `${WORKTREE}/src/GameState.java`))).toBe(false);
  });

  it('allows a relative path (resolved against the worktree cwd)', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'Edit', 'src/GameState.java'))).toBe(false);
  });

  it('passes through non-mutating tools (Read of the main repo is harmless)', async () => {
    const { cb } = getHook();
    const out = await run(cb, 'Read', '/repos/HyphoSphere/src/GameState.java');
    expect(out).toEqual({});
  });

  it('passes through a mutating tool with no path field present', async () => {
    const { cb } = getHook();
    expect(await run(cb, 'Write', undefined)).toEqual({});
  });

  it('blocks a sibling path that merely shares the worktree name prefix', async () => {
    const { cb } = getHook();
    expect(isDeny(await run(cb, 'Write', '/repos/HyphoSphere-worktrees/task-48-evil/x.txt'))).toBe(true);
  });
});

describe('buildWorktreeContainmentHooks — allowedWritePaths (task doc in the central archive)', () => {
  const TASK_DOC = '/home/u/.bottega/projects/10/tasks/task-48.md';

  function getAllowlistedHook(allowedWritePaths: string[]) {
    const hooks = buildWorktreeContainmentHooks({
      worktreeRoot: WORKTREE,
      enforceWorktree: true,
      allowedWritePaths,
    });
    const matchers = (hooks?.PreToolUse ?? []) as Array<{
      hooks: Array<(input: unknown) => Promise<unknown>>;
    }>;
    return matchers[0]?.hooks[0];
  }

  it('allows a Write to the allowlisted task doc outside the worktree', async () => {
    const cb = getAllowlistedHook([TASK_DOC]);
    expect(isDeny(await run(cb, 'Write', TASK_DOC))).toBe(false);
  });

  it('allows an Edit to the allowlisted task doc', async () => {
    const cb = getAllowlistedHook([TASK_DOC]);
    expect(isDeny(await run(cb, 'Edit', TASK_DOC))).toBe(false);
  });

  it("denies a SIBLING task's doc in the same archive folder", async () => {
    const cb = getAllowlistedHook([TASK_DOC]);
    expect(isDeny(await run(cb, 'Write', '/home/u/.bottega/projects/10/tasks/task-49.md'))).toBe(true);
  });

  it('denies a path that merely extends the allowlisted file name', async () => {
    const cb = getAllowlistedHook([TASK_DOC]);
    expect(isDeny(await run(cb, 'Write', `${TASK_DOC}.bak`))).toBe(true);
  });

  it('still denies the main repo when an allowlist is present', async () => {
    const cb = getAllowlistedHook([TASK_DOC]);
    expect(isDeny(await run(cb, 'Write', '/repos/HyphoSphere/src/GameState.java'))).toBe(true);
  });

  it('allows files under an allowlisted DIRECTORY entry', async () => {
    const cb = getAllowlistedHook(['/home/u/.bottega/projects/10/tasks/task-48']);
    expect(isDeny(await run(cb, 'Write', '/home/u/.bottega/projects/10/tasks/task-48/input_files/a.txt'))).toBe(false);
  });
});

describe('pathIsAllowlisted', () => {
  const DOC = '/home/u/.bottega/projects/10/tasks/task-48.md';
  it('matches the exact allowlisted file', () => {
    expect(pathIsAllowlisted(WORKTREE, [DOC], DOC)).toBe(true);
  });
  it('matches sep-bounded children of an allowlisted directory', () => {
    expect(pathIsAllowlisted(WORKTREE, ['/home/u/.bottega'], DOC)).toBe(true);
  });
  it('rejects a name-prefix false positive (task-48.md.bak)', () => {
    expect(pathIsAllowlisted(WORKTREE, [DOC], `${DOC}.bak`)).toBe(false);
  });
  it('rejects everything on an empty allowlist', () => {
    expect(pathIsAllowlisted(WORKTREE, [], DOC)).toBe(false);
  });
  it('normalizes traversal segments before matching', () => {
    expect(pathIsAllowlisted(WORKTREE, [DOC], '/home/u/.bottega/../.bottega/projects/10/tasks/task-48.md')).toBe(true);
  });
});

describe('pathEscapesWorktree', () => {
  it('treats the worktree root itself as not-escaping', () => {
    expect(pathEscapesWorktree(WORKTREE, WORKTREE)).toBe(false);
  });
  it('treats an empty path as not-escaping (nothing to block)', () => {
    expect(pathEscapesWorktree(WORKTREE, '')).toBe(false);
  });
  it('flags an absolute main-repo path as escaping', () => {
    expect(pathEscapesWorktree(WORKTREE, '/repos/HyphoSphere/src/X.java')).toBe(true);
  });
  it('does not flag a nested worktree path', () => {
    expect(pathEscapesWorktree(WORKTREE, `${WORKTREE}/a/b/c.java`)).toBe(false);
  });
});
