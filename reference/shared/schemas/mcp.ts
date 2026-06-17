// Runtime validation schemas for the `/api/mcp/*` routes.

import { z } from 'zod';

const mcpServerName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Name must be alphanumeric (hyphens/underscores allowed)');

const mcpScopeFields = {
  scope: z.enum(['global', 'project']).default('global'),
  projectId: z.coerce.number().int().positive().optional(),
};

export const AddMcpServerBodySchema = z
  .discriminatedUnion('transport', [
    z.object({
      transport: z.literal('stdio'),
      name: mcpServerName,
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      ...mcpScopeFields,
    }),
    z.object({
      transport: z.literal('http'),
      name: mcpServerName,
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      ...mcpScopeFields,
    }),
  ])
  .superRefine((data, ctx) => {
    if (data.scope === 'project' && data.projectId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'projectId is required when scope is project',
        path: ['projectId'],
      });
    }
  });
export type AddMcpServerBody = z.infer<typeof AddMcpServerBodySchema>;

export const TestMcpServersBodySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
});
export type TestMcpServersBody = z.infer<typeof TestMcpServersBodySchema>;
