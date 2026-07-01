import { describe, it, expect, vi } from 'vitest';

// askUserQuestion.ts pulls in the DB layer + session plumbing at module load.
// None of it is exercised by the worktree-containment branch (it returns before
// any AskUserQuestion/DB work), so stub the heavy deps to keep this a unit test.
vi.mock('../../database/db.js', () => ({
  conversationsDb: { getById: vi.fn() },
  tasksDb: { getWithProject: vi.fn() },
}));
vi.mock('../conversationContentStore.js', () => ({ resolveProjectKey: vi.fn() }));
vi.mock('../sqliteSessionStore.js', () => ({ sqliteSessionStore: { load: vi.fn() } }));
vi.mock('../localGpuQueue.js', () => ({
  localGpuQueue: { isLocalProvider: vi.fn(() => false), for: vi.fn() },
}));
vi.mock('./sessionState.js', () => ({ pendingAskUserQuestions: new Map() }));
vi.mock('./sdkOptions.js', () => ({ DEFAULT_PERMISSION_MODE: 'bypassPermissions' }));
vi.mock('./startConversation.js', () => ({ sendMessage: vi.fn() }));
vi.mock('./agentRunLifecycle.js', () => ({ processNextInQueue: vi.fn() }));

import { buildCanUseTool } from './askUserQuestion.js';

const WORKTREE = '/repos/HyphoSphere-worktrees/task-55';
const opts = {} as never;

describe('buildCanUseTool — worktree containment', () => {
  it('denies a Write whose absolute path points at the main repo', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'Write',
      { file_path: '/repos/HyphoSphere/src/SoundManager.java', content: 'x' } as never,
      opts,
    );
    expect(result.behavior).toBe('deny');
  });

  it('denies an Edit that escapes the worktree', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'Edit',
      { file_path: '/repos/HyphoSphere/src/GamePanel.java' } as never,
      opts,
    );
    expect(result.behavior).toBe('deny');
  });

  it('denies a NotebookEdit (notebook_path) outside the worktree', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'NotebookEdit',
      { notebook_path: '/repos/HyphoSphere/nb.ipynb' } as never,
      opts,
    );
    expect(result.behavior).toBe('deny');
  });

  it('allows a Write with an absolute path inside the worktree', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'Write',
      { file_path: `${WORKTREE}/src/SoundManager.java`, content: 'x' } as never,
      opts,
    );
    expect(result.behavior).toBe('allow');
  });

  it('allows a relative path (resolved against the worktree)', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'Edit',
      { file_path: 'src/SoundManager.java' } as never,
      opts,
    );
    expect(result.behavior).toBe('allow');
  });

  it('does NOT block reads of the main repo (reads are harmless to isolation)', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'Read',
      { file_path: '/repos/HyphoSphere/src/SoundManager.java' } as never,
      opts,
    );
    expect(result.behavior).toBe('allow');
  });

  it('does not enforce when enforceWorktree is false (uses_worktree=0 task → main allowed)', async () => {
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: false });
    const result = await canUseTool(
      'Write',
      { file_path: '/repos/HyphoSphere/src/SoundManager.java', content: 'x' } as never,
      opts,
    );
    expect(result.behavior).toBe('allow');
  });

  it('blocks a sibling path that shares the worktree name prefix', async () => {
    // Guard against `startsWith` false-positives: a sibling dir whose name
    // begins with the worktree path must NOT be treated as inside it.
    const canUseTool = buildCanUseTool({ worktreeRoot: WORKTREE, enforceWorktree: true });
    const result = await canUseTool(
      'Write',
      { file_path: '/repos/HyphoSphere-worktrees/task-55-evil/x.txt', content: 'x' } as never,
      opts,
    );
    expect(result.behavior).toBe('deny');
  });
});
