// Integration tests for the multi-repo epics extra, against the real db.ts
// (fresh SQLite file + archive root per run) so migrations, epicsDb and the
// service are exercised together. Git and agent runs are mocked.

import fs from 'fs';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const paths = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/bottega-epics-test-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${base}/test.db`;
  process.env.BOTTEGA_ARCHIVE_ROOT = `${base}/archive`;
  return { base };
});

vi.mock('./worktree.js', () => ({
  isGitRepository: vi.fn(async () => true),
  createWorktree: vi.fn(async (_repo: string, taskId: number) => ({
    success: true,
    branch: `task/${taskId}-branch`,
    worktreePath: `/tmp/wt/task-${taskId}`,
  })),
  removeWorktree: vi.fn(async () => ({ success: true })),
}));

vi.mock('./agentRunner.js', () => ({
  startAgentRun: vi.fn(async () => ({})),
  getRunningAgentForTask: vi.fn(() => null),
}));

import {
  initializeDatabase,
  userDb,
  projectsDb,
  tasksDb,
  epicsDb,
  agentRunsDb,
} from '../database/db.js';
import {
  EpicError,
  approveBreakdown,
  getEpicContext,
  getEpicOverview,
  holdIfDependenciesUnmet,
  parseBreakdown,
  releaseDependents,
  setChildProjects,
  syncEpicStatus,
  topologicalOrder,
} from './epicService.js';
import { getEpicBreakdownPath, readTaskDoc } from './documentation.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { startAgentRun } from './agentRunner.js';
import type { Breakdown } from '../../shared/schemas/epics.js';

let userId: number;
let seq = 0;

function makeProject(name: string, isUmbrella = false): number {
  seq += 1;
  return projectsDb.create(userId, name, `/repos/${name}-${seq}`, null, 'web', isUmbrella).id;
}

function makeUmbrella(): { umbrellaId: number; apiId: number; frontId: number } {
  const umbrellaId = makeProject('product', true);
  const apiId = makeProject('api');
  const frontId = makeProject('front');
  setChildProjects(umbrellaId, userId, [apiId, frontId]);
  return { umbrellaId, apiId, frontId };
}

function writeBreakdown(umbrellaId: number, epicId: number, breakdown: unknown): void {
  const file = getEpicBreakdownPath(umbrellaId, epicId);
  fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(breakdown), 'utf8');
}

function sampleBreakdown(apiId: number, frontId: number): Breakdown {
  return {
    summary: 'Export invoices as PDF',
    sharedContract: 'GET /invoices/:id/pdf → application/pdf',
    subtasks: [
      // Listed dependent-first on purpose: creation must follow dependencies.
      {
        key: 'front-button',
        projectId: frontId,
        title: 'Export button',
        description: 'Add the button.',
        dependsOn: ['api-endpoint'],
      },
      {
        key: 'api-endpoint',
        projectId: apiId,
        title: 'PDF endpoint',
        description: 'Serve the PDF.',
        dependsOn: [],
      },
    ],
  };
}

function makeReadyEpic() {
  const ids = makeUmbrella();
  const epicId = tasksDb.create(ids.umbrellaId, 'Invoice PDF export', false, userId).id;
  writeBreakdown(ids.umbrellaId, epicId, sampleBreakdown(ids.apiId, ids.frontId));
  tasksDb.update(epicId, { planification_complete: 1 });
  return { ...ids, epicId };
}

beforeAll(async () => {
  await initializeDatabase();
  userId = userDb.createUser('epic-tester', 'hash').id;
});

afterAll(() => {
  fs.rmSync(paths.base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('schema / migrations', () => {
  it('accepts the breakdown agent type', () => {
    const { umbrellaId } = makeUmbrella();
    const epicId = tasksDb.create(umbrellaId, 'Epic').id;
    expect(() => agentRunsDb.create(epicId, 'breakdown', null, 'anthropic')).not.toThrow();
  });

  it('exposes the umbrella flag on getWithProject', () => {
    const { umbrellaId, apiId } = makeUmbrella();
    const epicId = tasksDb.create(umbrellaId, 'Epic').id;
    const childTask = tasksDb.create(apiId, 'Child').id;
    expect(tasksDb.getWithProject(epicId)!.project_is_umbrella).toBe(1);
    expect(tasksDb.getWithProject(childTask)!.project_is_umbrella).toBe(0);
  });
});

describe('parseBreakdown', () => {
  const children = new Set([1, 2]);
  const base = {
    summary: 's',
    sharedContract: '',
    subtasks: [{ key: 'a', projectId: 1, title: 'A', description: 'd', dependsOn: [] }],
  };

  it('accepts a valid breakdown', () => {
    expect(parseBreakdown(JSON.stringify(base), children)).toEqual({ breakdown: base, errors: [] });
  });

  it('rejects invalid JSON', () => {
    expect(parseBreakdown('{nope', children).errors[0]).toMatch(/invalid JSON/);
  });

  it('reports schema issues with their path', () => {
    const bad = { ...base, subtasks: [{ ...base.subtasks[0], key: 'Not Valid' }] };
    expect(parseBreakdown(JSON.stringify(bad), children).errors[0]).toMatch(/^subtasks\.0\.key/);
  });

  it('rejects a project that is not a child of the umbrella', () => {
    const bad = { ...base, subtasks: [{ ...base.subtasks[0], projectId: 99 }] };
    expect(parseBreakdown(JSON.stringify(bad), children).errors.join()).toMatch(/projectId 99 is not a child/);
  });

  it('rejects duplicate keys, unknown dependencies and self-dependencies', () => {
    const bad = {
      ...base,
      subtasks: [
        { key: 'a', projectId: 1, title: 'A', description: 'd', dependsOn: ['a'] },
        { key: 'a', projectId: 2, title: 'B', description: 'd', dependsOn: ['zzz'] },
      ],
    };
    const errors = parseBreakdown(JSON.stringify(bad), children).errors.join('\n');
    expect(errors).toMatch(/duplicate key "a"/);
    expect(errors).toMatch(/depends on itself/);
    expect(errors).toMatch(/unknown key "zzz"/);
  });

  it('rejects dependency cycles', () => {
    const bad = {
      ...base,
      subtasks: [
        { key: 'a', projectId: 1, title: 'A', description: 'd', dependsOn: ['b'] },
        { key: 'b', projectId: 2, title: 'B', description: 'd', dependsOn: ['a'] },
      ],
    };
    expect(parseBreakdown(JSON.stringify(bad), children).errors).toEqual(['the dependencies form a cycle']);
  });
});

describe('topologicalOrder', () => {
  it('puts dependencies first and keeps file order otherwise', () => {
    const order = topologicalOrder(sampleBreakdown(1, 2).subtasks)!.map((s) => s.key);
    expect(order).toEqual(['api-endpoint', 'front-button']);
  });
});

describe('setChildProjects', () => {
  it('rejects a non-umbrella parent', () => {
    const a = makeProject('plain-a');
    const b = makeProject('plain-b');
    expect(() => setChildProjects(a, userId, [b])).toThrow(EpicError);
  });

  it('rejects an umbrella as a child', () => {
    const u1 = makeProject('u1', true);
    const u2 = makeProject('u2', true);
    expect(() => setChildProjects(u1, userId, [u2])).toThrow(/umbrella project and cannot be a child/);
  });

  it('refuses to steal a child from another umbrella', () => {
    const { apiId } = makeUmbrella();
    const other = makeProject('other-umbrella', true);
    try {
      setChildProjects(other, userId, [apiId]);
      expect.unreachable();
    } catch (err) {
      expect((err as EpicError).status).toBe(409);
    }
  });

  it('re-attaches orphans whose umbrella was deleted', () => {
    const { umbrellaId, apiId } = makeUmbrella();
    expect(projectsDb.delete(umbrellaId, userId)).toBe(true);
    expect(projectsDb.getByIdAdmin(apiId)!.parent_project_id).toBeNull();

    const newUmbrella = makeProject('new-umbrella', true);
    expect(setChildProjects(newUmbrella, userId, [apiId]).map((p) => p.id)).toEqual([apiId]);
  });

  it('re-attaches a child whose parent is no longer an umbrella', () => {
    const { apiId } = makeUmbrella();
    const plain = makeProject('plain-parent');
    // Simulate a stale link to a non-umbrella project.
    epicsDb.setChildProjects(plain, [apiId]);

    const newUmbrella = makeProject('another-umbrella', true);
    expect(setChildProjects(newUmbrella, userId, [apiId]).map((p) => p.id)).toEqual([apiId]);
  });

  it('replaces the children list', () => {
    const { umbrellaId, apiId, frontId } = makeUmbrella();
    expect(setChildProjects(umbrellaId, userId, [apiId]).map((p) => p.id)).toEqual([apiId]);
    expect(projectsDb.getByIdAdmin(frontId)!.parent_project_id).toBeNull();
  });
});

describe('approveBreakdown', () => {
  it('refuses before the breakdown agent completed', async () => {
    const { umbrellaId } = makeUmbrella();
    const epicId = tasksDb.create(umbrellaId, 'Epic').id;
    await expect(approveBreakdown(epicId, userId)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a task that is not an epic', async () => {
    const { apiId } = makeUmbrella();
    const taskId = tasksDb.create(apiId, 'Plain').id;
    await expect(approveBreakdown(taskId, userId)).rejects.toMatchObject({ status: 400 });
  });

  it('creates the sub-tasks in dependency order, wired to the epic', async () => {
    const { umbrellaId, apiId, frontId, epicId } = makeReadyEpic();

    const result = await approveBreakdown(epicId, userId);

    const [api, front] = result.subtasks;
    expect(api!.project_id).toBe(apiId);
    expect(front!.project_id).toBe(frontId);
    expect(result.subtasks.every((t) => t.parent_task_id === epicId && t.uses_worktree === 1)).toBe(true);
    expect(epicsDb.getDependencies(front!.id).map((t) => t.id)).toEqual([api!.id]);

    const frontDoc = readTaskDoc(frontId, front!.id);
    expect(frontDoc).toContain('# Export button');
    expect(frontDoc).toContain('GET /invoices/:id/pdf → application/pdf');
    expect(frontDoc).toContain(`Task #${api!.id} — PDF endpoint (api)`);
    expect(frontDoc).toContain(`task/${api!.id}-branch`);

    expect(result.epic.breakdown_approved).toBe(1);
    expect(result.epic.status).toBe('in_progress');
    expect(startAgentRun).not.toHaveBeenCalled();

    const overview = getEpicOverview(epicId);
    expect(overview.umbrella.id).toBe(umbrellaId);
    expect(overview.subtasks).toHaveLength(2);
    expect(overview.subtasks[1]!.dependsOn[0]).toMatchObject({ id: api!.id, satisfied: false });

    await expect(approveBreakdown(epicId, userId)).rejects.toMatchObject({ status: 409 });
  });

  it('starts planning on every sub-task when asked', async () => {
    const { epicId } = makeReadyEpic();
    const result = await approveBreakdown(epicId, userId, { startPlanning: true });
    expect(startAgentRun).toHaveBeenCalledTimes(2);
    for (const task of result.subtasks) {
      expect(startAgentRun).toHaveBeenCalledWith(task.id, 'planification', expect.objectContaining({ userId }));
    }
  });

  it('rolls everything back when a worktree cannot be created', async () => {
    const { apiId, frontId, epicId } = makeReadyEpic();
    vi.mocked(createWorktree)
      .mockResolvedValueOnce({ success: true, branch: 'task/x', worktreePath: '/tmp/x' })
      .mockResolvedValueOnce({ success: false, error: 'boom' });

    await expect(approveBreakdown(epicId, userId)).rejects.toMatchObject({ status: 500 });

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(tasksDb.getByProject(apiId)).toHaveLength(0);
    expect(tasksDb.getByProject(frontId)).toHaveLength(0);
    expect(tasksDb.getById(epicId)!.breakdown_approved).toBe(0);
  });
});

describe('dependency gating and scheduler', () => {
  async function approvedPair() {
    const { epicId } = makeReadyEpic();
    const { subtasks } = await approveBreakdown(epicId, userId);
    return { epicId, api: subtasks[0]!, front: subtasks[1]! };
  }

  it('parks a task whose dependencies are not ready', async () => {
    const { api, front } = await approvedPair();
    const broadcastToTaskSubscribersFn = vi.fn();

    expect(holdIfDependenciesUnmet(api.id)).toEqual([]);
    expect(holdIfDependenciesUnmet(front.id, { broadcastToTaskSubscribersFn }).map((t) => t.id)).toEqual([api.id]);
    expect(tasksDb.getById(front.id)!.waiting_on_dependencies).toBe(1);
    expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(
      front.id,
      expect.objectContaining({ type: 'task-updated' }),
    );
  });

  it('starts waiting dependents once their dependency PR is ready', async () => {
    const { api, front } = await approvedPair();
    holdIfDependenciesUnmet(front.id);

    // Not ready yet → nothing starts.
    expect(await releaseDependents(api.id)).toEqual([]);

    tasksDb.markPrAgentComplete(api.id);
    expect(await releaseDependents(api.id)).toEqual([front.id]);
    expect(startAgentRun).toHaveBeenCalledWith(front.id, 'implementation', expect.objectContaining({ userId }));
    expect(tasksDb.getById(front.id)!.waiting_on_dependencies).toBe(0);
    expect(getEpicContext(front.id).dependsOn[0]).toMatchObject({ id: api.id, satisfied: true });
  });

  it('runs YOLO dependents through the yolo agent', async () => {
    const { api, front } = await approvedPair();
    tasksDb.update(front.id, { yolo_mode: 1 });
    holdIfDependenciesUnmet(front.id);
    tasksDb.update(api.id, { status: 'completed' });

    await releaseDependents(api.id);
    expect(startAgentRun).toHaveBeenCalledWith(front.id, 'yolo', expect.anything());
  });

  it('leaves dependents alone when they never asked to start', async () => {
    const { api } = await approvedPair();
    tasksDb.markPrAgentComplete(api.id);
    expect(await releaseDependents(api.id)).toEqual([]);
    expect(startAgentRun).not.toHaveBeenCalled();
  });
});

describe('syncEpicStatus', () => {
  it('completes the epic when every sub-task is completed, and reopens it otherwise', async () => {
    const { epicId } = makeReadyEpic();
    const { subtasks } = await approveBreakdown(epicId, userId);

    tasksDb.update(subtasks[0]!.id, { status: 'completed' });
    expect(syncEpicStatus(epicId)).toBeNull();

    tasksDb.update(subtasks[1]!.id, { status: 'completed' });
    expect(syncEpicStatus(epicId)!.status).toBe('completed');

    tasksDb.update(subtasks[1]!.id, { status: 'in_progress' });
    expect(syncEpicStatus(epicId)!.status).toBe('in_progress');
  });
});
