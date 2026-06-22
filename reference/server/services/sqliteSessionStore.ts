/**
 * SqliteSessionStore — Claude Agent SDK custom sessionStore backend.
 *
 * The SDK calls these methods instead of writing transcript JSONL files for our
 * use; they become the single source of truth for conversation messages. The
 * SDK still writes its own JSONL copies under CLAUDE_CONFIG_DIR, but our app
 * never reads them — that's the SDK's private scratch space.
 *
 * Contract is from `@anthropic-ai/claude-agent-sdk` (alpha, v0.2.132+):
 *   append(key, entries), load(key), listSessions(projectKey),
 *   listSessionSummaries(projectKey), delete(key),
 *   listSubkeys({ projectKey, sessionId }).
 */

import { foldSessionSummary } from '@anthropic-ai/claude-agent-sdk';
import { db as defaultDb } from '../database/db.js';

interface SessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string | null;
  /**
   * Which provider's entries are being appended. Anthropic entries
   * (default) feed `foldSessionSummary` so `listSessionSummaries`
   * surfaces them; Codex and OpenCode entries are written verbatim and
   * skip the summary fold — the SDK helper is typed for the Claude
   * SessionStoreEntry shape and would mis-handle non-Claude
   * UnifiedMessages.
   */
  provider?: 'anthropic' | 'openai' | 'opencode' | 'ollama';
}

interface ProjectSessionKey {
  projectKey: string;
  sessionId: string;
}

interface TranscriptEntry {
  uuid?: string;
  [key: string]: unknown;
}

interface SessionListing {
  sessionId: string;
  mtime: number;
}

// Loose typing of the better-sqlite3 instance — db.js is plain JS so the
// import is `any`. We only use prepare()/transaction() here.
type DbInstance = typeof defaultDb;

function normalizeSubpath(subpath: string | null | undefined): string {
  return subpath === undefined || subpath === null ? '' : subpath;
}

export class SqliteSessionStore {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
  }

  async append(key: SessionKey, entries: TranscriptEntry[]): Promise<void> {
    if (!entries || entries.length === 0) return;

    const projectKey = key.projectKey;
    const sessionId = key.sessionId;
    const subpath = normalizeSubpath(key.subpath);
    const mtime = Date.now();

    const maxRow = this.db
      .prepare(
        'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM messages WHERE project_key = ? AND session_id = ? AND subpath = ?',
      )
      .get(projectKey, sessionId, subpath) as { max_seq?: number } | undefined;
    let nextSeq = (maxRow?.max_seq ?? -1) + 1;

    const insert = this.db.prepare(`
      INSERT INTO messages (project_key, session_id, subpath, uuid, seq, mtime, entry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, session_id, subpath, uuid) DO UPDATE SET
        seq = excluded.seq,
        mtime = excluded.mtime,
        entry_json = excluded.entry_json
    `);

    const upsertSummary = this.db.prepare(`
      INSERT INTO session_summaries (project_key, session_id, mtime, summary_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_key, session_id) DO UPDATE SET
        mtime = excluded.mtime,
        summary_json = excluded.summary_json
    `);

    const selectSummary = this.db.prepare(
      'SELECT summary_json FROM session_summaries WHERE project_key = ? AND session_id = ?',
    );

    const txn = this.db.transaction((batch: TranscriptEntry[]) => {
      for (const entry of batch) {
        const seq = nextSeq++;
        const uuid =
          entry.uuid && typeof entry.uuid === 'string' && entry.uuid.length > 0
            ? entry.uuid
            : `__no_uuid:${mtime}:${seq}`;
        const json = JSON.stringify(entry);
        insert.run(projectKey, sessionId, subpath, uuid, seq, mtime, json);
      }

      // Fold summary on the main transcript only — subagent transcripts don't
      // get their own listSessions() row, so a summary would never be returned
      // for them anyway. Also gate on provider: Codex entries are not in
      // the Claude SessionStoreEntry shape `foldSessionSummary` expects.
      const provider = key.provider ?? 'anthropic';
      if (subpath === '' && provider === 'anthropic') {
        const prevRow = selectSummary.get(projectKey, sessionId) as
          | { summary_json: string }
          | undefined;
        const prev = prevRow ? JSON.parse(prevRow.summary_json) : undefined;
        // The SDK's foldSessionSummary types its `entries` arg as SDK
        // SessionStoreEntry[]. Our TranscriptEntry is the on-the-wire JSON
        // we received and round-trip — same runtime shape, looser TS view.
        const summary = foldSessionSummary(
          prev,
          { projectKey, sessionId },
          batch as never,
          { mtime },
        );
        upsertSummary.run(
          projectKey,
          sessionId,
          mtime,
          JSON.stringify(summary),
        );
      }
    });

    txn(entries);
  }

  async load(key: SessionKey): Promise<TranscriptEntry[] | null> {
    const projectKey = key.projectKey;
    const sessionId = key.sessionId;
    const subpath = normalizeSubpath(key.subpath);

    const probe = this.db
      .prepare(
        'SELECT 1 FROM messages WHERE project_key = ? AND session_id = ? AND subpath = ? LIMIT 1',
      )
      .get(projectKey, sessionId, subpath);
    if (!probe) return null;

    const rows = this.db
      .prepare(
        'SELECT entry_json FROM messages WHERE project_key = ? AND session_id = ? AND subpath = ? ORDER BY seq ASC',
      )
      .all(projectKey, sessionId, subpath) as Array<{ entry_json: string }>;

    return rows.map((row) => JSON.parse(row.entry_json) as TranscriptEntry);
  }

  /**
   * Like {@link load}, but drops the oldest whole turns once the estimated
   * token count exceeds `maxContextTokens`. Only applied to the main
   * transcript (subpath '') — see {@link truncateToFitContext} for the
   * turn-boundary logic that keeps tool_use/tool_result pairs intact.
   */
  async loadTruncated(key: SessionKey, maxContextTokens: number): Promise<TranscriptEntry[] | null> {
    const entries = await this.load(key);
    if (!entries || normalizeSubpath(key.subpath) !== '') return entries;
    return truncateToFitContext(entries, maxContextTokens);
  }

  async delete(key: SessionKey): Promise<void> {
    const projectKey = key.projectKey;
    const sessionId = key.sessionId;
    const subpath = normalizeSubpath(key.subpath);

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM messages WHERE project_key = ? AND session_id = ? AND subpath = ?',
        )
        .run(projectKey, sessionId, subpath);

      // Per SDK contract: delete is per-key — does NOT cascade to subagent
      // subpaths. Drop the summary only when we deleted the main transcript.
      if (subpath === '') {
        this.db
          .prepare(
            'DELETE FROM session_summaries WHERE project_key = ? AND session_id = ?',
          )
          .run(projectKey, sessionId);
      }
    });

    txn();
  }

  async listSessions(projectKey: string): Promise<SessionListing[]> {
    const rows = this.db
      .prepare(
        `
      SELECT session_id AS sessionId, MAX(mtime) AS mtime
      FROM messages
      WHERE project_key = ? AND subpath = ''
      GROUP BY session_id
      ORDER BY mtime DESC
    `,
      )
      .all(projectKey) as SessionListing[];
    return rows;
  }

  async listSessionSummaries(projectKey: string): Promise<unknown[]> {
    const rows = this.db
      .prepare(
        'SELECT summary_json FROM session_summaries WHERE project_key = ? ORDER BY mtime DESC',
      )
      .all(projectKey) as Array<{ summary_json: string }>;
    return rows.map((row) => JSON.parse(row.summary_json));
  }

  async listSubkeys(key: ProjectSessionKey): Promise<string[]> {
    const rows = this.db
      .prepare(
        `
      SELECT DISTINCT subpath
      FROM messages
      WHERE project_key = ? AND session_id = ? AND subpath != ''
      ORDER BY subpath ASC
    `,
      )
      .all(key.projectKey, key.sessionId) as Array<{ subpath: string }>;
    return rows.map((row) => row.subpath);
  }

  // App-side purge: removes every message row and the summary for a session,
  // across all subpaths (main + subagents). Distinct from delete(), which is
  // the SDK-contract per-key delete that intentionally does NOT cascade.
  async purgeSession(key: ProjectSessionKey): Promise<void> {
    const projectKey = key.projectKey;
    const sessionId = key.sessionId;

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM messages WHERE project_key = ? AND session_id = ?',
        )
        .run(projectKey, sessionId);

      this.db
        .prepare(
          'DELETE FROM session_summaries WHERE project_key = ? AND session_id = ?',
        )
        .run(projectKey, sessionId);
    });

    txn();
  }
}

export const sqliteSessionStore = new SqliteSessionStore();

// ────────────────────────────────────────────────────────────────────────────
// Context-window truncation for small-context local models (Ollama, local-ai)
// ────────────────────────────────────────────────────────────────────────────
//
// The Claude Agent SDK's native auto-compact (`Options.settings.autoCompactWindow`)
// has a hard `min(100_000)` floor in its zod schema — useless against a local
// model's real context window (often 4k-32k). Anthropic's own context window is
// large enough that this never bites in practice; a local server's is not. So
// for ollama/local-ai we truncate the resumed history ourselves, at the
// sessionStore boundary, before it ever reaches the subprocess.

/**
 * True when `entry` is a real human/queued prompt that starts a new turn —
 * as opposed to a synthetic `type: 'user'` entry carrying a tool_result
 * (Claude transcripts represent both with the same `type`). A tool_result
 * entry's `message.content` is an array of content blocks; a real prompt's
 * is a plain string.
 */
function isRealUserTurnStart(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false;
  const message = entry.message as { content?: unknown } | undefined;
  return typeof message?.content === 'string';
}

/** Cheap token estimate (~4 chars/token) — good enough for a budget, not billing. */
function estimateEntryTokens(entry: TranscriptEntry): number {
  return Math.ceil(JSON.stringify(entry).length / 4);
}

/**
 * Drop the oldest whole turns from `entries` until the estimated token count
 * fits `maxContextTokens`. A "turn" runs from one real user prompt up to (not
 * including) the next, so every tool_use is always kept alongside its
 * tool_result — never split mid-turn. Entries before the first real prompt
 * (session init/system bookkeeping) form turn 0 and age out like any other.
 *
 * Always keeps at least the most recent turn, even if it alone exceeds the
 * budget — an empty resume is worse than one oversized turn, and that turn
 * still hits the same hard limit a non-truncated resume would have.
 */
export function truncateToFitContext(
  entries: TranscriptEntry[],
  maxContextTokens: number,
): TranscriptEntry[] {
  if (entries.length === 0) return entries;

  const turnStarts: number[] = [0];
  entries.forEach((entry, i) => {
    if (i > 0 && isRealUserTurnStart(entry)) turnStarts.push(i);
  });

  const turns: TranscriptEntry[][] = turnStarts.map((start, i) =>
    entries.slice(start, turnStarts[i + 1] ?? entries.length),
  );

  const kept: TranscriptEntry[][] = [];
  let budget = maxContextTokens;
  for (const turn of [...turns].reverse()) {
    const turnTokens = turn.reduce((sum, e) => sum + estimateEntryTokens(e), 0);
    if (kept.length > 0 && turnTokens > budget) break;
    kept.unshift(turn);
    budget -= turnTokens;
  }

  return kept.flat();
}

/**
 * Wrap `store` so `load()` returns a truncated transcript for the main
 * transcript only (subagent subpaths are passed through verbatim — they
 * don't carry the multi-turn user-prompt boundaries this relies on, and in
 * practice the main transcript is what grows unbounded).
 */
export function createTruncatingSessionStore(
  store: SqliteSessionStore,
  maxContextTokens: number,
): SqliteSessionStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'load') {
        return (key: SessionKey) => target.loadTruncated(key, maxContextTokens);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
