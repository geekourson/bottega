import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db-helper.js';
import {
  SqliteSessionStore,
  truncateToFitContext,
  createTruncatingSessionStore,
} from './sqliteSessionStore.js';

// Mirrors the production estimate (chars/4) so tests can pick thresholds
// that land exactly on a turn boundary instead of guessing.
function approxTokens(entry: unknown): number {
  return Math.ceil(JSON.stringify(entry).length / 4);
}

describe('SqliteSessionStore', () => {
  let testDb: TestDatabase;
  // Tests pass partial entry shapes to store.append; keep loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any;

  beforeEach(() => {
    testDb = createTestDatabase();
    store = new SqliteSessionStore(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  function entry(overrides: Record<string, unknown> = {}) {
    return {
      type: 'user',
      uuid: (overrides.uuid as string | undefined) ?? 'u-' + Math.random().toString(36).slice(2),
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'hi' },
      ...overrides,
    };
  }

  it('append + load round-trips entries in order', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    const entries = [
      entry({ uuid: 'a', message: { role: 'user', content: 'first' } }),
      entry({ uuid: 'b', message: { role: 'assistant', content: 'second' } }),
      entry({ uuid: 'c', message: { role: 'user', content: 'third' } }),
    ];

    await store.append(key, entries);
    const loaded = await store.load(key);

    expect(loaded).toHaveLength(3);
    expect(loaded.map((e: { uuid: string }) => e.uuid)).toEqual(['a', 'b', 'c']);
    expect(loaded[0].message.content).toBe('first');
  });

  it('load() returns null for an unknown session (not [])', async () => {
    const result = await store.load({ projectKey: 'p1', sessionId: 'never-written' });
    expect(result).toBeNull();
  });

  it('preserves order across multiple append() batches', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    await store.append(key, [entry({ uuid: 'a' }), entry({ uuid: 'b' })]);
    await store.append(key, [entry({ uuid: 'c' })]);
    await store.append(key, [entry({ uuid: 'd' }), entry({ uuid: 'e' })]);

    const loaded = await store.load(key);
    expect(loaded.map((e: { uuid: string }) => e.uuid)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('upserts on uuid (idempotent) — replaying a batch does not duplicate', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    const batch = [entry({ uuid: 'a' }), entry({ uuid: 'b' })];

    await store.append(key, batch);
    await store.append(key, batch);
    await store.append(key, batch);

    const loaded = await store.load(key);
    expect(loaded).toHaveLength(2);
  });

  it('upsert overwrites entry_json with the latest payload', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    await store.append(key, [entry({ uuid: 'a', message: { role: 'user', content: 'v1' } })]);
    await store.append(key, [entry({ uuid: 'a', message: { role: 'user', content: 'v2' } })]);

    const loaded = await store.load(key);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].message.content).toBe('v2');
  });

  it('entries without a uuid get unique synthetic keys (no dedup, no PK collision)', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    const noUuid = { type: 'title', message: 'whatever' };

    await store.append(key, [noUuid, noUuid, noUuid]);
    const loaded = await store.load(key);
    expect(loaded).toHaveLength(3);
  });

  it('isolates entries by subpath (main vs subagent transcripts)', async () => {
    const main = { projectKey: 'p1', sessionId: 's1' };
    const sub = { projectKey: 'p1', sessionId: 's1', subpath: 'subagents/agent-1.jsonl' };

    await store.append(main, [entry({ uuid: 'main-a' })]);
    await store.append(sub, [entry({ uuid: 'sub-a' })]);

    expect((await store.load(main)).map((e: { uuid: string }) => e.uuid)).toEqual(['main-a']);
    expect((await store.load(sub)).map((e: { uuid: string }) => e.uuid)).toEqual(['sub-a']);
  });

  it('isolates entries by projectKey (same sessionId across projects)', async () => {
    await store.append({ projectKey: 'p1', sessionId: 's1' }, [entry({ uuid: 'p1-a' })]);
    await store.append({ projectKey: 'p2', sessionId: 's1' }, [entry({ uuid: 'p2-a' })]);

    expect((await store.load({ projectKey: 'p1', sessionId: 's1' })).map((e: { uuid: string }) => e.uuid)).toEqual(['p1-a']);
    expect((await store.load({ projectKey: 'p2', sessionId: 's1' })).map((e: { uuid: string }) => e.uuid)).toEqual(['p2-a']);
  });

  it('delete() is per-key and does NOT cascade to subagent subpaths', async () => {
    const main = { projectKey: 'p1', sessionId: 's1' };
    const sub = { projectKey: 'p1', sessionId: 's1', subpath: 'subagents/agent-1.jsonl' };
    await store.append(main, [entry({ uuid: 'main-a' })]);
    await store.append(sub, [entry({ uuid: 'sub-a' })]);

    await store.delete(main);

    expect(await store.load(main)).toBeNull();
    expect(await store.load(sub)).toEqual([expect.objectContaining({ uuid: 'sub-a' })]);
  });

  it('purgeSession() removes main + subagent rows and the summary, scoped to (projectKey, sessionId)', async () => {
    const main = { projectKey: 'p1', sessionId: 's1' };
    const sub = { projectKey: 'p1', sessionId: 's1', subpath: 'subagents/agent-1.jsonl' };
    const otherSession = { projectKey: 'p1', sessionId: 's2' };
    const otherProject = { projectKey: 'p2', sessionId: 's1' };
    await store.append(main, [entry({ uuid: 'main-a' })]);
    await store.append(sub, [entry({ uuid: 'sub-a' })]);
    await store.append(otherSession, [entry({ uuid: 'other-session' })]);
    await store.append(otherProject, [entry({ uuid: 'other-project' })]);

    await store.purgeSession(main);

    expect(await store.load(main)).toBeNull();
    expect(await store.load(sub)).toBeNull();
    expect(await store.load(otherSession)).not.toBeNull();
    expect(await store.load(otherProject)).not.toBeNull();

    const summaries = await store.listSessionSummaries('p1');
    expect(summaries.find((s: { sessionId: string }) => s.sessionId === 's1')).toBeUndefined();
    expect(summaries.find((s: { sessionId: string }) => s.sessionId === 's2')).toBeDefined();
  });

  it('listSessions returns sessions ordered by MAX(mtime) DESC', async () => {
    await store.append({ projectKey: 'p1', sessionId: 'old' }, [entry({ uuid: 'a' })]);
    // small artificial wait so mtime values differ
    await new Promise(r => setTimeout(r, 5));
    await store.append({ projectKey: 'p1', sessionId: 'new' }, [entry({ uuid: 'b' })]);

    const list = await store.listSessions('p1');
    expect(list.map((s: { sessionId: string }) => s.sessionId)).toEqual(['new', 'old']);
    expect(list[0].mtime).toBeGreaterThanOrEqual(list[1].mtime);
  });

  it('listSessions excludes subagent subpath entries (only main transcripts)', async () => {
    await store.append({ projectKey: 'p1', sessionId: 'main-only' }, [entry({ uuid: 'a' })]);
    await store.append({ projectKey: 'p1', sessionId: 'sub-only', subpath: 'subagents/x.jsonl' }, [entry({ uuid: 'b' })]);

    const list = await store.listSessions('p1');
    expect(list.map((s: { sessionId: string }) => s.sessionId)).toEqual(['main-only']);
  });

  it('listSubkeys returns subagent subpaths but excludes the main transcript', async () => {
    const baseKey = { projectKey: 'p1', sessionId: 's1' };
    await store.append(baseKey, [entry({ uuid: 'main-a' })]);
    await store.append({ ...baseKey, subpath: 'subagents/a.jsonl' }, [entry({ uuid: 'a' })]);
    await store.append({ ...baseKey, subpath: 'subagents/b.jsonl' }, [entry({ uuid: 'b' })]);

    const subkeys = await store.listSubkeys(baseKey);
    expect(subkeys).toEqual(['subagents/a.jsonl', 'subagents/b.jsonl']);
  });

  it('listSessionSummaries maintains a fold per session and returns them', async () => {
    await store.append({ projectKey: 'p1', sessionId: 's1' }, [
      entry({ uuid: 'a', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/p1' }),
    ]);
    await store.append({ projectKey: 'p1', sessionId: 's2' }, [
      entry({ uuid: 'b', timestamp: '2026-01-02T00:00:00Z', cwd: '/tmp/p1' }),
    ]);

    const summaries = await store.listSessionSummaries('p1');
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('seq is monotonically increasing within a session, independent across sessions', async () => {
    await store.append({ projectKey: 'p1', sessionId: 's1' }, [entry({ uuid: 'a' })]);
    await store.append({ projectKey: 'p1', sessionId: 's1' }, [entry({ uuid: 'b' }), entry({ uuid: 'c' })]);
    await store.append({ projectKey: 'p1', sessionId: 's2' }, [entry({ uuid: 'd' })]);

    const s1Rows = testDb.db.prepare(
      "SELECT uuid, seq FROM messages WHERE session_id = 's1' ORDER BY seq ASC"
    ).all() as { seq: number }[];
    expect(s1Rows.map(r => r.seq)).toEqual([0, 1, 2]);

    const s2Rows = testDb.db.prepare(
      "SELECT uuid, seq FROM messages WHERE session_id = 's2' ORDER BY seq ASC"
    ).all() as { seq: number }[];
    expect(s2Rows.map(r => r.seq)).toEqual([0]);
  });

  it('append([]) is a no-op', async () => {
    await store.append({ projectKey: 'p1', sessionId: 's1' }, []);
    expect(await store.load({ projectKey: 'p1', sessionId: 's1' })).toBeNull();
  });

  it('subpath = undefined and subpath = "" both target the main transcript', async () => {
    await store.append({ projectKey: 'p1', sessionId: 's1' }, [entry({ uuid: 'a' })]);
    await store.append({ projectKey: 'p1', sessionId: 's1', subpath: '' }, [entry({ uuid: 'b' })]);

    const loaded = await store.load({ projectKey: 'p1', sessionId: 's1' });
    expect(loaded.map((e: { uuid: string }) => e.uuid)).toEqual(['a', 'b']);
  });
});

describe('truncateToFitContext', () => {
  function userTurnStart(uuid: string, content: string) {
    return { type: 'user', uuid, message: { role: 'user', content } };
  }

  function assistantText(uuid: string, content: string) {
    return { type: 'assistant', uuid, message: { role: 'assistant', content } };
  }

  function toolUse(uuid: string, id: string) {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
    };
  }

  // A tool_result is itself a `type: 'user'` entry, but its content is an
  // array of blocks, not a string — this is what distinguishes it from a
  // real turn-starting prompt.
  function toolResult(uuid: string, id: string) {
    return {
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    };
  }

  it('returns entries unchanged when everything fits the budget', () => {
    const entries = [userTurnStart('a', 'hi'), assistantText('b', 'hello')];
    const result = truncateToFitContext(entries, 100_000);
    expect(result).toEqual(entries);
  });

  it('returns [] unchanged for empty input', () => {
    expect(truncateToFitContext([], 100)).toEqual([]);
  });

  it('drops the oldest whole turn while keeping the most recent turn intact', () => {
    const turn1 = [userTurnStart('a', 'x'.repeat(2000)), assistantText('b', 'y'.repeat(2000))];
    const turn2 = [userTurnStart('c', 'recent question'), assistantText('d', 'recent answer')];
    const entries = [...turn1, ...turn2];

    const turn2Tokens = turn2.reduce((sum, e) => sum + approxTokens(e), 0);
    // Budget fits turn2 alone but not turn1 + turn2.
    const budget = turn2Tokens + 10;

    const result = truncateToFitContext(entries, budget);
    expect(result.map((e: { uuid?: string }) => e.uuid)).toEqual(['c', 'd']);
  });

  it('never splits a turn — a tool_use stays paired with its tool_result even under tight budget', () => {
    const oldTurn = [userTurnStart('a', 'old')];
    const recentTurn = [
      userTurnStart('c', 'do a thing'),
      toolUse('d', 'tool-1'),
      toolResult('e', 'tool-1'),
      assistantText('f', 'done'),
    ];
    const entries = [...oldTurn, ...recentTurn];

    const recentTurnTokens = recentTurn.reduce((sum, e) => sum + approxTokens(e), 0);
    const budget = recentTurnTokens + 5;

    const result = truncateToFitContext(entries, budget);
    expect(result.map((e: { uuid?: string }) => e.uuid)).toEqual(['c', 'd', 'e', 'f']);
  });

  it('treats a type:"user" tool_result entry as a continuation, not a new turn boundary', () => {
    // If tool_result were mistaken for a turn start, this single logical
    // turn would split into two and 'c'..'f' could be dropped independently
    // from 'e'/'f' — breaking the tool_use/tool_result pairing.
    const entries = [
      userTurnStart('a', 'do a thing'),
      toolUse('b', 'tool-1'),
      toolResult('c', 'tool-1'),
      assistantText('d', 'done'),
    ];

    const result = truncateToFitContext(entries, 1);
    expect(result.map((e: { uuid?: string }) => e.uuid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('always keeps at least the most recent turn, even if it alone exceeds the budget', () => {
    const entries = [
      userTurnStart('a', 'old'),
      userTurnStart('b', 'x'.repeat(5000)),
      assistantText('c', 'y'.repeat(5000)),
    ];

    const result = truncateToFitContext(entries, 1);
    expect(result.map((e: { uuid?: string }) => e.uuid)).toEqual(['b', 'c']);
  });

  it('entries before the first real user prompt form turn 0 and age out like any other turn', () => {
    const leading = [{ type: 'system', uuid: 'sys', message: 'init' }];
    const turn1 = [userTurnStart('a', 'first'), assistantText('b', 'reply')];
    const turn2 = [userTurnStart('c', 'second'), assistantText('d', 'reply2')];
    const entries = [...leading, ...turn1, ...turn2];

    const turn2Tokens = turn2.reduce((sum, e) => sum + approxTokens(e), 0);
    const result = truncateToFitContext(entries, turn2Tokens + 5);

    expect(result.map((e: { uuid?: string }) => e.uuid)).toEqual(['c', 'd']);
  });
});

describe('createTruncatingSessionStore', () => {
  let testDb: TestDatabase;
  let store: SqliteSessionStore;

  beforeEach(() => {
    testDb = createTestDatabase();
    store = new SqliteSessionStore(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it('truncates the main transcript (subpath "") on load()', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    const oldTurn = [
      { type: 'user', uuid: 'a', message: { role: 'user', content: 'x'.repeat(5000) } },
      { type: 'assistant', uuid: 'b', message: { role: 'assistant', content: 'y'.repeat(5000) } },
    ];
    const recentTurn = [
      { type: 'user', uuid: 'c', message: { role: 'user', content: 'recent' } },
      { type: 'assistant', uuid: 'd', message: { role: 'assistant', content: 'reply' } },
    ];
    await store.append(key, [...oldTurn, ...recentTurn]);

    const wrapped = createTruncatingSessionStore(store, 100);
    const loaded = await wrapped.load(key);

    expect(loaded?.map((e: { uuid?: string }) => e.uuid)).toEqual(['c', 'd']);
  });

  it('leaves subagent subpaths untouched (no turn boundaries to truncate against)', async () => {
    const key = { projectKey: 'p1', sessionId: 's1', subpath: 'subagents/agent-1.jsonl' };
    const entries = [
      { type: 'user', uuid: 'a', message: { role: 'user', content: 'x'.repeat(5000) } },
      { type: 'assistant', uuid: 'b', message: { role: 'assistant', content: 'y'.repeat(5000) } },
    ];
    await store.append(key, entries);

    const wrapped = createTruncatingSessionStore(store, 1);
    const loaded = await wrapped.load(key);

    expect(loaded?.map((e: { uuid?: string }) => e.uuid)).toEqual(['a', 'b']);
  });

  it('does not affect append()/delete() — only load() is intercepted', async () => {
    const key = { projectKey: 'p1', sessionId: 's1' };
    const wrapped = createTruncatingSessionStore(store, 1);

    await wrapped.append(key, [{ type: 'user', uuid: 'a', message: { role: 'user', content: 'hi' } }]);
    expect(await store.load(key)).not.toBeNull();

    await wrapped.delete(key);
    expect(await store.load(key)).toBeNull();
  });
});
