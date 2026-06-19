import { z } from 'zod';

export const SaveGitHubTokenBodySchema = z.object({
  token: z.string().min(1, 'Token is required'),
});
export type SaveGitHubTokenBody = z.infer<typeof SaveGitHubTokenBodySchema>;

export const UpdateProjectSettingsBodySchema = z.object({
  github_token: z.string().optional(),
});
export type UpdateProjectSettingsBody = z.infer<typeof UpdateProjectSettingsBodySchema>;
