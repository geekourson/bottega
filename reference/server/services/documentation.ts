import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectType } from '../../shared/types/db.js';

const TASKS_FOLDER = 'tasks';
const RECORDINGS_FOLDER = 'recordings';
const INPUT_FILES_FOLDER = 'input_files';
const TMP_FOLDER = 'tmp';

/**
 * Root of the central per-user archive for task documentation, attachments,
 * and recordings. These files live outside the project repo so they survive
 * worktree destruction on task merge.
 *
 * Override with BOTTEGA_ARCHIVE_ROOT in tests.
 */
function getArchiveRoot(): string {
  return process.env.BOTTEGA_ARCHIVE_ROOT || path.join(os.homedir(), '.bottega');
}

function getProjectArchivePath(projectId: number): string {
  return path.join(getArchiveRoot(), 'projects', String(projectId));
}

function getArchiveTasksFolderPath(projectId: number): string {
  return path.join(getProjectArchivePath(projectId), TASKS_FOLDER);
}

function getArchiveRecordingsFolderPath(projectId: number): string {
  return path.join(getProjectArchivePath(projectId), RECORDINGS_FOLDER);
}

export function getTaskDocPath(projectId: number, taskId: number): string {
  return path.join(getArchiveTasksFolderPath(projectId), `task-${taskId}.md`);
}

export function getTaskInputFilesPath(projectId: number, taskId: number): string {
  return path.join(getArchiveTasksFolderPath(projectId), `task-${taskId}`, INPUT_FILES_FOLDER);
}

/**
 * Restores the task doc to its original request content after a reset.
 * If the file contains a plan (has an "## Original Request" section), extracts
 * the blockquote content and rewrites the file with just that. If the file has
 * no plan yet (raw user description), leaves it untouched.
 */
export function resetTaskDoc(projectId: number, taskId: number): void {
  const docPath = getTaskDocPath(projectId, taskId);
  if (!fs.existsSync(docPath)) return;

  const content = fs.readFileSync(docPath, 'utf-8');

  // Split on level-2 headings to find the Original Request section
  const parts = content.split(/\n(?=## )/);
  const originalRequestPart = parts.find(p => p.startsWith('## Original Request'));
  if (!originalRequestPart) return;

  // Extract blockquote lines and strip the "> " prefix
  const blockquoteLines = originalRequestPart
    .split('\n')
    .filter(line => line.startsWith('> ') || line === '>');
  if (blockquoteLines.length === 0) return;

  const restored = blockquoteLines.map(line => line.replace(/^> ?/, '')).join('\n').trim();
  fs.writeFileSync(docPath, restored + '\n', 'utf-8');
}

export function getRecordingPath(projectId: number, taskId: number): string {
  return path.join(getArchiveRecordingsFolderPath(projectId), `task-${taskId}.webm`);
}

function getTmpFolderPath(repoPath: string): string {
  return path.join(repoPath, TMP_FOLDER);
}

/**
 * The project's own README.md, read/written in place at the root of the
 * cloned repo (unlike task docs, which live in the central archive).
 */
export function getProjectReadmePath(repoPath: string): string {
  return path.join(repoPath, 'README.md');
}

/**
 * Per-project business constraints. Unlike the README, these live in the
 * central archive (NOT in the repo): they are private (never committed), and
 * the agent is told they are authoritative and must NOT edit them. This is the
 * "Tier 1" guardrail channel — see buildContextPrompt's "Project Constraints"
 * section.
 */
export function getProjectConstraintsPath(projectId: number): string {
  return path.join(getProjectArchivePath(projectId), 'constraints.md');
}

export function readProjectConstraints(projectId: number): string {
  try {
    const constraintsPath = getProjectConstraintsPath(projectId);
    if (!fs.existsSync(constraintsPath)) {
      return '';
    }
    return fs.readFileSync(constraintsPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read project constraints: ${message}`);
    throw error;
  }
}

export function writeProjectConstraints(projectId: number, content: string): void {
  try {
    const constraintsPath = getProjectConstraintsPath(projectId);
    fs.mkdirSync(path.dirname(constraintsPath), { recursive: true });
    fs.writeFileSync(constraintsPath, content, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write project constraints: ${message}`);
    throw error;
  }
}

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.rb': 'text/x-ruby',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++',
    '.css': 'text/css',
    '.scss': 'text/x-scss',
    '.html': 'text/html',
    '.xml': 'text/xml',
    '.sh': 'application/x-sh',
    '.bash': 'application/x-sh',
    '.sql': 'text/x-sql',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function ensureProjectArchive(projectId: number): void {
  const tasksPath = getArchiveTasksFolderPath(projectId);
  fs.mkdirSync(tasksPath, { recursive: true });
}

export function ensureTmpFolder(repoPath: string): string {
  try {
    const tmpPath = getTmpFolderPath(repoPath);
    if (!fs.existsSync(tmpPath)) {
      fs.mkdirSync(tmpPath, { recursive: true });
    }
    return tmpPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to ensure tmp folder: ${message}`);
    throw error;
  }
}

export interface SavedUploadInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export function saveConversationUpload(
  repoPath: string,
  filename: string,
  buffer: Buffer,
): SavedUploadInfo {
  try {
    const tmpPath = ensureTmpFolder(repoPath);
    const sanitizedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(tmpPath, sanitizedName);

    fs.writeFileSync(filePath, buffer);

    const stats = fs.statSync(filePath);
    const ext = path.extname(sanitizedName).toLowerCase();

    return {
      name: sanitizedName,
      absolutePath: filePath,
      relativePath: `./tmp/${sanitizedName}`,
      size: stats.size,
      mimeType: getMimeType(ext),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to save conversation upload: ${message}`);
    throw error;
  }
}

export function readTaskDoc(projectId: number, taskId: number): string {
  try {
    const docPath = getTaskDocPath(projectId, taskId);

    if (!fs.existsSync(docPath)) {
      return '';
    }

    return fs.readFileSync(docPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read task documentation: ${message}`);
    throw error;
  }
}

export function writeTaskDoc(projectId: number, taskId: number, content: string): void {
  try {
    ensureProjectArchive(projectId);

    const docPath = getTaskDocPath(projectId, taskId);
    fs.writeFileSync(docPath, content, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write task documentation: ${message}`);
    throw error;
  }
}

export function readProjectReadme(repoPath: string): string {
  try {
    const readmePath = getProjectReadmePath(repoPath);

    if (!fs.existsSync(readmePath)) {
      return '';
    }

    return fs.readFileSync(readmePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read project README: ${message}`);
    throw error;
  }
}

export function writeProjectReadme(repoPath: string, content: string): void {
  try {
    fs.writeFileSync(getProjectReadmePath(repoPath), content, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write project README: ${message}`);
    throw error;
  }
}

export function deleteTaskDoc(projectId: number, taskId: number): boolean {
  try {
    const docPath = getTaskDocPath(projectId, taskId);

    if (!fs.existsSync(docPath)) {
      return false;
    }

    fs.unlinkSync(docPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to delete task documentation: ${message}`);
    throw error;
  }
}

export function deleteTaskArchive(projectId: number, taskId: number): void {
  try {
    const docPath = getTaskDocPath(projectId, taskId);
    if (fs.existsSync(docPath)) {
      fs.unlinkSync(docPath);
    }

    const taskFolder = path.join(getArchiveTasksFolderPath(projectId), `task-${taskId}`);
    if (fs.existsSync(taskFolder)) {
      fs.rmSync(taskFolder, { recursive: true, force: true });
    }

    const recordingPath = getRecordingPath(projectId, taskId);
    if (fs.existsSync(recordingPath)) {
      fs.unlinkSync(recordingPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to delete task archive: ${message}`);
    throw error;
  }
}

export interface InputFileInfo {
  name: string;
  size: number;
  mimeType: string;
}

function listInputFiles(inputFilesPath: string): InputFileInfo[] {
  if (!fs.existsSync(inputFilesPath)) {
    return [];
  }

  const entries = fs.readdirSync(inputFilesPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const stats = fs.statSync(path.join(inputFilesPath, entry.name));
      const ext = path.extname(entry.name).toLowerCase();
      return {
        name: entry.name,
        size: stats.size,
        mimeType: getMimeType(ext),
      };
    });
}

function saveInputFile(
  inputFilesPath: string,
  filename: string,
  buffer: Buffer,
): InputFileInfo {
  const sanitizedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(inputFilesPath, sanitizedName);

  fs.writeFileSync(filePath, buffer);

  const ext = path.extname(sanitizedName).toLowerCase();

  return {
    name: sanitizedName,
    size: buffer.length,
    mimeType: getMimeType(ext),
  };
}

function deleteInputFile(inputFilesPath: string, filename: string): boolean {
  const filePath = path.join(inputFilesPath, path.basename(filename));

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

export function ensureTaskInputFilesFolder(projectId: number, taskId: number): string {
  const inputFilesPath = getTaskInputFilesPath(projectId, taskId);
  fs.mkdirSync(inputFilesPath, { recursive: true });
  return inputFilesPath;
}

export function listTaskInputFiles(projectId: number, taskId: number): InputFileInfo[] {
  return listInputFiles(getTaskInputFilesPath(projectId, taskId));
}

export function saveTaskInputFile(
  projectId: number,
  taskId: number,
  filename: string,
  buffer: Buffer,
): InputFileInfo {
  const inputFilesPath = ensureTaskInputFilesFolder(projectId, taskId);
  return saveInputFile(inputFilesPath, filename, buffer);
}

export function deleteTaskInputFile(
  projectId: number,
  taskId: number,
  filename: string,
): boolean {
  return deleteInputFile(getTaskInputFilesPath(projectId, taskId), filename);
}

/**
 * Calculate the dev server port for a task
 * Uses convention: 3100 + (task_id % 900) to get ports in range 3100-3999
 */
export function getDevServerPort(taskId: number): number {
  return 3100 + (taskId % 900);
}

/**
 * Build the per-project-type "Verification Profile" body that goes inside the
 * "## Testing Configuration" section of the agent system prompt.
 *
 * This is the floor of how the review agent is expected to verify work for this
 * kind of project. The plan's Testing Strategy adds task-specific scenarios on
 * top; it cannot drop below this floor. Only `web` (and `api`) warrant a running
 * dev server, and only `web` warrants Playwright/browser testing — injecting
 * browser instructions into a CLI or library task was the root cause of the
 * implementation↔review runaway loop.
 */
function buildVerificationProfileBody(projectType: ProjectType, devServerPort: number): string {
  switch (projectType) {
    case 'web':
      return `When running Playwright MCP tests, start the project's dev server on port ${devServerPort}:
1. Check project files (README, package.json, Procfile) for the start command
2. Start server with your assigned port (e.g., \`PORT=${devServerPort} bin/dev\` or \`npm run dev -- --port ${devServerPort}\`)
3. Run Playwright tests against \`http://localhost:${devServerPort}\`
4. Stop the server when testing is complete: \`lsof -ti:${devServerPort} | xargs kill -9 2>/dev/null || true\`

- **Dev Server Port:** ${devServerPort}`;

    case 'api':
      return `This is a backend/API project — verify it over HTTP, **not** through a browser. Do NOT use Playwright.
1. Check project files (README, package.json, Procfile) for the start command
2. Start the server on your assigned port (e.g., \`PORT=${devServerPort} npm run dev\`)
3. Exercise the affected endpoints with \`curl\` against \`http://localhost:${devServerPort}\` and assert on status codes / response bodies
4. Where relevant, inspect database state to confirm side effects
5. Stop the server when done: \`lsof -ti:${devServerPort} | xargs kill -9 2>/dev/null || true\`

- **Dev Server Port:** ${devServerPort}`;

    case 'cli':
      return `This is a command-line project — verify it by invoking the built command and asserting on its output and exit code. There is no dev server and no browser; do NOT use Playwright.
1. Build the project if required (check README / package.json)
2. Run the affected command(s) with representative arguments
3. Assert on stdout/stderr and the exit code; where relevant, inspect files or state the command produced`;

    case 'library':
      return `This is a library — verify it through its automated test suite. There is no dev server and no browser; do NOT use Playwright or attempt to start a server.
1. Run the unit/integration tests covering the changed code
2. Confirm the public API behaves as specified (types, return values, error cases)`;

    case 'game':
      return `This is a game project — verify it by building and launching it. Do NOT use the web Playwright flow.
1. Build the project (check README / project files for the engine's build command)
2. Launch the build and confirm it runs without errors
3. Verify the affected behavior using the engine's own tooling / logs where available`;
  }
}

/**
 * Build a context prompt from task documentation and input files.
 * Task doc + input files live in the central archive (per-user).
 *
 * `projectType` selects the Verification Profile injected below; it defaults to
 * `'web'` so existing callers (and pre-typing projects) keep today's behavior.
 */
export function buildContextPrompt(
  projectId: number,
  taskId: number,
  repoPath?: string,
  projectType: ProjectType = 'web',
): string {
  const devServerPort = getDevServerPort(taskId);

  const sections: string[] = [];

  if (repoPath) {
    const readmePath = getProjectReadmePath(repoPath);
    if (fs.existsSync(readmePath)) {
      sections.push(`## Project README

This project has a README at:
\`${readmePath}\`

**At the start of this conversation, read this file using the Read tool.** It documents the project's purpose, stack, and how to set up and run it locally — read it before exploring the codebase further.

If your work changes how the project is set up, run, or structured in a way the README no longer reflects, update the README directly with the Edit tool so it stays accurate for the next person (or agent).`);
    }
  }

  // Per-project business constraints (authoritative guardrails). Injected only
  // when non-empty. Unlike the README, these are NOT in the repo and the agent
  // must NOT edit them.
  const constraints = readProjectConstraints(projectId).trim();
  if (constraints) {
    sections.push(`## Project Constraints (authoritative)

These are hard, project-specific rules and business constraints set by the project owner. Treat them as **MUST / MUST NOT** requirements that override your default judgment. If a task appears to require violating a constraint, do NOT proceed — surface the conflict instead.

Do NOT edit, delete, or "update" these constraints — they are managed by the project owner outside the repository.

${constraints}`);
  }

  const taskDocPath = getTaskDocPath(projectId, taskId);
  sections.push(`## Task Plan File

The canonical task plan — also known as the specification for this task — is stored at:
\`${taskDocPath}\`

**At the start of this conversation, before answering the user's first message, you MUST read this file in full using the Read tool.** It contains the requirements, constraints, and prior decisions you need to do this work correctly. Do not skip this step even if the user's first message looks unrelated to the plan.

When the user refers to the "task plan", "task doc", "task spec", "specifications", or asks you to read or update the task documentation, this is the file — read or edit it directly with the Read/Edit tool. Do NOT search for it elsewhere; the path above is authoritative.

Note: any \`.bottega/tasks/*.md\` files inside the repo itself are legacy from before task docs were moved to a central archive. Ignore them — the path above is the only source of truth.`);

  const inputFiles = listTaskInputFiles(projectId, taskId);
  if (inputFiles.length > 0) {
    const inputFilesPath = getTaskInputFilesPath(projectId, taskId);
    const fileList = inputFiles.map((f) => `- ${f.name}`).join('\n');
    sections.push(
      `## Input Files\n\nIMPORTANT: At the start of this conversation, you MUST read ALL files in the following directory to get context:\n${inputFilesPath}\n\nFiles to read:\n${fileList}\n\nUse the Read tool to read each file before proceeding with any other actions. These files contain important context for this task.`,
    );
  }

  sections.push(`## Testing Configuration

- **Task ID:** ${taskId}

### Verification Profile (project type: ${projectType})

${buildVerificationProfileBody(projectType, devServerPort)}

### Test Execution Best Practices

When running the project's test suite:

1. **Run targeted tests first**: Only run test files related to your changes. This gives fast feedback.
2. **Full suite = background**: When running the complete test suite, ALWAYS use \`run_in_background: true\` on the Bash tool. Full suites can take 5-15 minutes and will exceed the default timeout.
3. **Wait for backgrounded tests before re-launching**: If a test command gets backgrounded (you receive a task ID), wait for it to complete using TaskOutput with \`block: true\`. Do NOT start another test run while one is still running — parallel suites compete for resources and take even longer. Only re-launch if the previous run completed and failed.
4. **Use fail-fast flags**: If the test framework supports it, use a fail-fast option to exit on first failure.
5. **Set generous timeouts**: If not using run_in_background, set \`timeout: 600000\` (10 minutes) for full test suites.`);

  return sections.join('\n\n---\n\n');
}

// Export path helper functions for testing
export const _internal = {
  getTmpFolderPath,
  getMimeType,
  getArchiveRoot,
  getProjectArchivePath,
  getArchiveTasksFolderPath,
  getArchiveRecordingsFolderPath,
};
