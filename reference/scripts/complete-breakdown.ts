#!/usr/bin/env node

/**
 * CLI script the breakdown agent runs to signal its epic breakdown is ready
 * (multi-repo epics extra — extra/multi-repo-epics.md).
 *
 * Validates the breakdown JSON next to the epic doc with the exact rules the
 * server applies at approval time. On failure it prints every issue and exits
 * non-zero so the agent fixes the file and retries; on success it sets
 * `planification_complete` — the loop's "plan ready, stop for a human" flag.
 *
 * Usage: tsx scripts/complete-breakdown.ts <epicTaskId>
 */

import { tasksDb, initializeDatabase } from '../server/database/db.js';
import { isEpic, readEpicBreakdown } from '../server/services/epicService.js';
import { getEpicBreakdownPath } from '../server/services/documentation.js';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

async function completeBreakdown(taskIdArg: string | undefined): Promise<void> {
  if (!taskIdArg) {
    console.error(`${colors.red}Error:${colors.reset} Epic task ID is required`);
    console.log('\nUsage: tsx scripts/complete-breakdown.ts <epicTaskId>');
    process.exit(1);
  }

  const taskId = parseInt(taskIdArg, 10);
  if (isNaN(taskId)) {
    console.error(`${colors.red}Error:${colors.reset} Task ID must be a number`);
    process.exit(1);
  }

  const epic = tasksDb.getWithProject(taskId);
  if (!epic) {
    console.error(`${colors.red}Error:${colors.reset} Task with ID ${taskId} not found`);
    process.exit(1);
  }
  if (!isEpic(epic)) {
    console.error(`${colors.red}Error:${colors.reset} Task ${taskId} is not an epic (its project is not an umbrella)`);
    process.exit(1);
  }

  const { breakdown, errors } = readEpicBreakdown(epic);
  if (!breakdown) {
    console.error(`${colors.red}Breakdown is invalid${colors.reset} (${getEpicBreakdownPath(epic.project_id, taskId)}):`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error('\nFix the file and run this script again.');
    process.exit(1);
  }

  tasksDb.update(taskId, { planification_complete: 1 });

  console.log('');
  console.log(`${colors.green}${colors.bright}Breakdown validated — waiting for human approval.${colors.reset}`);
  console.log(`${colors.cyan}Epic:${colors.reset} #${taskId} ${epic.title || ''}`);
  console.log(`${colors.cyan}Sub-tasks:${colors.reset} ${breakdown.subtasks.length}`);
  console.log('');
}

await initializeDatabase();
await completeBreakdown(process.argv[2]);
