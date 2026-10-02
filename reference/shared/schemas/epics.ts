// Runtime validation schemas for the multi-repo epics extra
// (extra/multi-repo-epics.md): the breakdown file the breakdown agent writes,
// and the `/api/*` bodies of the epic routes (`server/routes/epics.ts`).
//
// The breakdown schema is shared by the server (approval) and by
// `scripts/complete-breakdown.ts` (the agent's completion signal), so the
// agent gets exactly the errors the server would reject it for.

import { z } from 'zod';

export const MAX_BREAKDOWN_SUBTASKS = 30;

export const BreakdownSubtaskSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'key must only contain lowercase letters, digits and dashes'),
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1, 'title is required').max(200),
  description: z.string().trim().min(1, 'description is required'),
  dependsOn: z.array(z.string()).default([]),
  // Optional overrides; empty = defaults (branch `task/<id>-<title-slug>`,
  // PR title chosen by the PR agent). Same character rules as
  // server/services/validators.ts `assertValidBranchName`.
  branch: z
    .string()
    .trim()
    .max(200)
    .regex(/^([A-Za-z0-9][A-Za-z0-9_./-]*)?$/, 'branch may only contain letters, digits, ".", "_", "/" and "-", and must start with a letter or digit')
    .refine((b) => !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock'), 'branch is not a valid git branch name')
    .optional(),
  prTitle: z.string().trim().max(256).optional(),
});
export type BreakdownSubtask = z.infer<typeof BreakdownSubtaskSchema>;

export const BreakdownSchema = z.object({
  summary: z.string().trim().min(1, 'summary is required'),
  sharedContract: z.string().default(''),
  subtasks: z
    .array(BreakdownSubtaskSchema)
    .min(1, 'at least one sub-task is required')
    .max(MAX_BREAKDOWN_SUBTASKS, `at most ${MAX_BREAKDOWN_SUBTASKS} sub-tasks`),
});
export type Breakdown = z.infer<typeof BreakdownSchema>;

export const ApproveBreakdownBodySchema = z.object({
  startPlanning: z.boolean().optional(),
});
export type ApproveBreakdownBody = z.infer<typeof ApproveBreakdownBodySchema>;

export const SetChildProjectsBodySchema = z.object({
  childIds: z.array(z.number().int().positive()).max(50),
});
export type SetChildProjectsBody = z.infer<typeof SetChildProjectsBodySchema>;
