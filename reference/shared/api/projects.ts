// Request/response shapes for the project endpoints:
//  - /api/projects/*                    (CRUD)
//  - /api/projects/:id/upload
//  - /api/projects/:id/web-server*      (mounted via webServer.js)
//  - /api/projects/:id/files            (inline handler in server/index.js)

import type { ProjectRow, ProjectType } from '../types/db';
import { expectType } from './_common';

// ---- Project CRUD ---------------------------------------------------------
//
// `getAllProjects(userId)` and `getProject(id, userId)` return raw
// `ProjectRow` shapes — there is no `task_counts` decoration today, despite
// what the earlier docs implied. If we ever add aggregation, define a
// `ProjectListItem` with `Pick<ProjectRow, …> & { task_counts: ... }` and
// migrate ListProjectsResponse to that.

export type ListProjectsResponse = ProjectRow[];

export type GetProjectResponse = ProjectRow;

export interface CreateProjectRequest {
  name: string;
  repoFolderPath: string;
  subprojectPath?: string;
  projectType?: ProjectType;
}

export type CreateProjectResponse = ProjectRow;

export interface UpdateProjectRequest {
  name?: string | undefined;
  repoFolderPath?: string | undefined;
  subprojectPath?: string | undefined;
  projectType?: ProjectType | undefined;
}

export type UpdateProjectResponse = ProjectRow;

export interface DeleteProjectResponse {
  success: true;
}

// ---- README -----------------------------------------------------------------
//
// Reads/writes the project's own README.md, in place at the root of the
// cloned repo (unlike task docs, which live in the central archive). Agents
// (notably the PO agent, see `generatePoMessage`) are pointed at this same
// on-disk file, so edits made here are immediately visible to them.

export interface GetProjectReadmeResponse {
  content: string;
}

export type UpdateProjectReadmeResponse = GetProjectReadmeResponse;

// ---- Constraints ------------------------------------------------------------
//
// Per-project business constraints. Unlike the README these live in the central
// archive (private, not committed) and are surfaced to every agent as an
// authoritative "## Project Constraints" system-prompt section.

export interface GetProjectConstraintsResponse {
  content: string;
}

export type UpdateProjectConstraintsResponse = GetProjectConstraintsResponse;

// ---- Per-project prompt overrides (Tier 2) ---------------------------------
//
// A project can fully replace an agent prompt. Resolution at render time is
// project override → user-global override → bundled default. These endpoints
// edit the project layer only; `hasGlobalOverride` is surfaced so the UI can
// explain what a reset falls back to.

export interface ProjectPromptListItem {
  name: string;
  label: string;
  kind: string;
  hasProjectOverride: boolean;
  hasGlobalOverride: boolean;
}

export type ListProjectPromptsResponse = ProjectPromptListItem[];

export interface GetProjectPromptResponse {
  name: string;
  label: string;
  kind: string;
  variables: string[];
  // Bundled default content.
  defaultContent: string;
  // The project override body, or null when no project override exists.
  projectContent: string | null;
  // The content actually used at render time (project → global → default).
  effectiveContent: string;
  hasProjectOverride: boolean;
  hasGlobalOverride: boolean;
  // mtime of the project override; null when there is no project override.
  mtime: number | null;
}

export interface SaveProjectPromptResponse {
  name: string;
  mtime: number;
  hasProjectOverride: true;
}

// ---- Files ----------------------------------------------------------------

// `/api/projects/:id/files` returns the file tree used by `@`-mention
// completion. The handler lives inline in `server/index.js`; the shape
// is one entry per file under the repo (subset suitable for autocomplete).
export interface ProjectFile {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export type GetProjectFilesResponse = ProjectFile[];

// ---- Upload ---------------------------------------------------------------
//
// Multipart upload to `tmp/`. The success body wraps a typed `file` shape
// produced by `saveConversationUpload()` — note `absolutePath` /
// `relativePath` are deliberate (consumers reference files by relative
// path in subsequent prompts).

export interface UploadedFile {
  name: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export interface UploadProjectFileResponse {
  success: true;
  file: UploadedFile;
}

// ---- Web server (mounted under projects) ----------------------------------
//
// Returns from the `webServerManager` service. The success/error envelope
// is reused across all four endpoints so the shape on the wire mixes
// success/failure fields. Consumers should branch on `success`.

export interface WebServerStatusSuccess {
  success: true;
  activeTaskId: number | null;
  serveSymlinkPath: string | null;
  systemdServiceName: string | null;
  // Public URL of the deployed app; opened in a new tab after a successful
  // switch. `null` (or empty) means "don't open a tab".
  appUrl: string | null;
  isConfigured: boolean;
}

export interface WebServerStatusError {
  success: false;
  error: string;
}

export type GetWebServerResponse = WebServerStatusSuccess | WebServerStatusError;

export interface UpdateWebServerConfigRequest {
  serveSymlinkPath?: string | undefined;
  systemdServiceName?: string | undefined;
  appUrl?: string | undefined;
}

export type UpdateWebServerConfigResponse =
  | { success: true; project: ProjectRow }
  | { success: false; error: string };

export interface SwitchWebServerRequest {
  // `null` switches back to the main repo; a number switches to that
  // task's worktree.
  taskId: number | null;
}

export type SwitchWebServerResponse =
  | {
      success: true;
      activeTaskId: number | null;
      // Present when the symlink updated but the systemd restart warned.
      warning?: string;
    }
  | { success: false; error: string };

export interface VerifyWebServerSuccess {
  success: true;
  matches: boolean;
  expectedTarget: string;
  actualTarget: string | null;
  symlinkExists: boolean;
  // Set when the symlink doesn't exist on disk but we still return 200.
  error?: string;
}

export interface VerifyWebServerError {
  success: false;
  error: string;
}

export type VerifyWebServerResponse = VerifyWebServerSuccess | VerifyWebServerError;

// ---- Type-level smoke checks ---------------------------------------------

expectType<ListProjectsResponse>([] as ProjectRow[]);
expectType<GetProjectResponse>({} as ProjectRow);
