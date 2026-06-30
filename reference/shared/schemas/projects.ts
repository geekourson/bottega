// Runtime validation schemas for the `/api/projects/*` routes
// (`server/routes/projects.ts`).

import { z } from 'zod';

// Mirror of the `ProjectType` union in shared/types/db.ts. Kept as a zod enum
// here so the HTTP boundary rejects unknown values with a 400, and inferred
// back into the same literal type via z.infer at the call sites.
export const ProjectTypeSchema = z.enum(['web', 'api', 'cli', 'game', 'library']);

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1, 'Project name is required'),
  repoFolderPath: z
    .string()
    .trim()
    .min(1, 'Repository folder path is required'),
  subprojectPath: z.string().optional(),
  projectType: ProjectTypeSchema.default('web'),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const UpdateProjectBodySchema = z.object({
  name: z.string().optional(),
  repoFolderPath: z.string().optional(),
  // The DB layer accepts `null` to clear the column, and the existing
  // type `UpdateProjectRequest` allows `undefined`. Be permissive here.
  subprojectPath: z.string().nullable().optional(),
  projectType: ProjectTypeSchema.optional(),
});
export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;

export const UpdateProjectReadmeBodySchema = z.object({
  content: z.string(),
});
export type UpdateProjectReadmeBody = z.infer<typeof UpdateProjectReadmeBodySchema>;

export const UpdateProjectConstraintsBodySchema = z.object({
  content: z.string(),
});
export type UpdateProjectConstraintsBody = z.infer<typeof UpdateProjectConstraintsBodySchema>;

// Per-project agent prompt override (Tier 2). `expectedMtime` is an optional
// optimistic-concurrency guard mirroring the global prompt editor.
export const UpdateProjectPromptBodySchema = z.object({
  content: z.string(),
  expectedMtime: z.number().optional(),
});
export type UpdateProjectPromptBody = z.infer<typeof UpdateProjectPromptBodySchema>;
