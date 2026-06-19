#!/usr/bin/env node

/**
 * CLI script to create a new task in a project.
 * Used by the PO agent to persist validated task proposals.
 *
 * Usage: tsx scripts/create-task.ts <projectId> "<title>" ["<description>"]
 */

import { projectsDb, tasksDb, initializeDatabase } from '../server/database/db.js';
import { isGitRepository, createWorktree } from '../server/services/worktree.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

async function createTask(
  projectIdStr: string | undefined,
  title: string | undefined,
  description: string | undefined,
): Promise<void> {
  if (!projectIdStr || !title) {
    console.error(`${colors.red}Error:${colors.reset} projectId and title are required`);
    console.log('\nUsage: tsx scripts/create-task.ts <projectId> "<title>" ["<description>"]');
    process.exit(1);
  }

  const projectId = parseInt(projectIdStr, 10);
  if (isNaN(projectId)) {
    console.error(`${colors.red}Error:${colors.reset} projectId must be a number`);
    process.exit(1);
  }

  const project = projectsDb.getByIdAdmin(projectId);
  if (!project) {
    console.error(`${colors.red}Error:${colors.reset} Project ${projectId} not found`);
    process.exit(1);
  }

  const created = tasksDb.create(projectId, title.trim(), false, null);

  // Create a git worktree for the task if the project is a git repository
  if (await isGitRepository(project.repo_folder_path)) {
    const result = await createWorktree(
      project.repo_folder_path,
      created.id,
      title.trim(),
      project.subproject_path ?? null,
    );
    if (result.success) {
      console.log(`${colors.cyan}Worktree:${colors.reset} ${result.worktreePath} (${result.branch})`);
    } else {
      console.warn(`Warning: could not create worktree — ${result.error}`);
    }
  }

  // Write the description as the task doc if provided
  if (description && description.trim()) {
    const taskDocDir = path.join(os.homedir(), '.bottega', 'projects', String(projectId), 'tasks');
    fs.mkdirSync(taskDocDir, { recursive: true });
    const taskDocPath = path.join(taskDocDir, `task-${created.id}.md`);
    fs.writeFileSync(taskDocPath, `# ${title.trim()}\n\n${description.trim()}\n`, 'utf8');
  }

  console.log('');
  console.log(`${colors.green}${colors.bright}Task created!${colors.reset}`);
  console.log(`${colors.cyan}Task ID:${colors.reset} ${created.id}`);
  console.log(`${colors.cyan}Title:${colors.reset} ${title.trim()}`);
  console.log(`${colors.cyan}Project:${colors.reset} ${project.name} (ID: ${projectId})`);
  console.log('');
}

const [, , projectIdArg, titleArg, descriptionArg] = process.argv;

await initializeDatabase();
await createTask(projectIdArg, titleArg, descriptionArg);
