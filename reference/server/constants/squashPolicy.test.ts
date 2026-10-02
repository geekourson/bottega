// The "one commit per PR" project setting drives the {{squashPolicy}} block
// injected into the committing agents' prompts.

import fs from 'fs';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const paths = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/bottega-squash-test-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${base}/test.db`;
  process.env.BOTTEGA_ARCHIVE_ROOT = `${base}/archive`;
  return { base };
});

import { initializeDatabase, userDb, projectsDb, projectSettingsDb } from '../database/db.js';
import { buildSquashPolicy, generatePrAgentMessage } from './agentPrompts.js';
import { isSquashBeforePr } from '../services/prService.js';

let projectId: number;

beforeAll(async () => {
  await initializeDatabase();
  const userId = userDb.createUser('squash-tester', 'hash').id;
  projectId = projectsDb.create(userId, 'repo', '/repos/squash-repo').id;
});

afterAll(() => {
  fs.rmSync(paths.base, { recursive: true, force: true });
});

describe('squash before PR', () => {
  it('is off by default: no policy block', async () => {
    expect(isSquashBeforePr(projectId)).toBe(false);
    expect(buildSquashPolicy(projectId)).toBe('');
    const message = await generatePrAgentMessage('/doc.md', 1, null, projectId);
    expect(message).not.toContain('One commit per PR');
    expect(message).toContain('## Commit messages');
  });

  it('injects the squash policy into the PR agent prompt when enabled', async () => {
    projectSettingsDb.setValue(projectId, 'squash_before_pr', '1');

    expect(isSquashBeforePr(projectId)).toBe(true);
    const message = await generatePrAgentMessage('/doc.md', 1, null, projectId);
    expect(message).toContain('## One commit per PR (repository policy)');
    expect(message).toContain('git reset --soft $(git merge-base HEAD origin/main)');
    expect(message).toContain('git push --force-with-lease');
  });
});
