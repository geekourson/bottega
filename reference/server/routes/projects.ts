import express, { type Request, type Response } from 'express';
import { projectsDb, projectSettingsDb } from '../database/db.js';
import {
  getAllProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../services/projectService.js';
import {
  saveConversationUpload,
  readProjectReadme,
  writeProjectReadme,
} from '../services/documentation.js';
import { upload } from '../middleware/upload.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  CreateProjectResponse,
  DeleteProjectResponse,
  GetProjectReadmeResponse,
  GetProjectResponse,
  ListProjectsResponse,
  UpdateProjectReadmeResponse,
  UpdateProjectResponse,
  UploadProjectFileResponse,
} from '../../shared/api/projects.js';
import type { ProjectUpdates } from '../database/db.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  IdParamsSchema,
  type IdParams,
} from '../../shared/schemas/_common.js';
import {
  CreateProjectBodySchema,
  type CreateProjectBody,
  UpdateProjectBodySchema,
  type UpdateProjectBody,
  UpdateProjectReadmeBodySchema,
  type UpdateProjectReadmeBody,
} from '../../shared/schemas/projects.js';
import {
  UpdateProjectSettingsBodySchema,
  type UpdateProjectSettingsBody,
} from '../../shared/schemas/github.js';

const router = express.Router();

router.get('/', (req: Request, res: Response<ListProjectsResponse | ApiError>) => {
  try {
    const userId = req.user!.id;
    const projects = getAllProjects(userId);
    res.json(projects);
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

router.post(
  '/',
  validateBody(CreateProjectBodySchema),
  (
    req: Request,
    res: Response<CreateProjectResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const { name, repoFolderPath, subprojectPath } = req.validated!.body as CreateProjectBody;

      const project = projectsDb.create(
        userId,
        name.trim(),
        repoFolderPath.trim(),
        subprojectPath?.trim() || null,
      );

      // The pre-TS handler returned the `projectsDb.create` summary
      // directly (camelCase keys, no created_at). Preserving that exact
      // shape on the wire avoids breaking existing clients; the
      // CreateProjectResponse type is wider than what we actually return.
      res.status(201).json(project as unknown as CreateProjectResponse);
    } catch (error) {
      console.error('Error creating project:', error);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
        return res
          .status(409)
          .json({ error: 'A project with this repository path already exists' });
      }
      res.status(500).json({ error: 'Failed to create project' });
    }
  },
);

router.get(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<GetProjectResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json(project);
    } catch (error) {
      console.error('Error getting project:', error);
      res.status(500).json({ error: 'Failed to get project' });
    }
  },
);

router.put(
  '/:id',
  validateParams(IdParamsSchema),
  validateBody(UpdateProjectBodySchema),
  (
    req: Request,
    res: Response<UpdateProjectResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;
      const body = req.validated!.body as UpdateProjectBody;

      const updates: ProjectUpdates = {};
      if (body.name !== undefined) {
        updates.name = body.name.trim();
      }
      if (body.repoFolderPath !== undefined) {
        updates.repo_folder_path = body.repoFolderPath.trim();
      }
      if (body.subprojectPath !== undefined) {
        updates.subproject_path = body.subprojectPath?.trim() || null;
      }

      const project = updateProject(projectId, userId, updates);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json(project);
    } catch (error) {
      console.error('Error updating project:', error);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
        return res
          .status(409)
          .json({ error: 'A project with this repository path already exists' });
      }
      res.status(500).json({ error: 'Failed to update project' });
    }
  },
);

router.delete(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<DeleteProjectResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const deleted = deleteProject(projectId, userId);
      if (!deleted) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting project:', error);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  },
);

router.post(
  '/:id/upload',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<UploadProjectFileResponse | ApiError>) => {
    const userId = req.user!.id;
    const { id: projectId } = req.validated!.params as IdParams;

    const project = getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return res.status(400).json({ error: message });
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      try {
        const fileInfo = saveConversationUpload(
          project.repo_folder_path,
          file.originalname,
          file.buffer,
        );
        res.status(201).json({ success: true, file: fileInfo });
      } catch (saveError) {
        console.error('Error saving upload:', saveError);
        res.status(500).json({ error: 'Failed to save file' });
      }
    });
  },
);

// GET /projects/:id/settings
router.get(
  '/:id/settings',
  validateParams(IdParamsSchema),
  (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' } satisfies ApiError);
      }

      const githubToken = projectSettingsDb.getValue(projectId, 'github_token');
      res.json({ github_token_set: Boolean(githubToken) });
    } catch (error) {
      console.error('Error getting project settings:', error);
      res.status(500).json({ error: 'Failed to get project settings' } satisfies ApiError);
    }
  },
);

// PUT /projects/:id/settings
router.put(
  '/:id/settings',
  validateParams(IdParamsSchema),
  validateBody(UpdateProjectSettingsBodySchema),
  (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;
      const body = req.validated!.body as UpdateProjectSettingsBody;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' } satisfies ApiError);
      }

      if (body.github_token !== undefined) {
        if (body.github_token) {
          projectSettingsDb.setValue(projectId, 'github_token', body.github_token);
        } else {
          projectSettingsDb.deleteValue(projectId, 'github_token');
        }
      }

      const githubToken = projectSettingsDb.getValue(projectId, 'github_token');
      res.json({ github_token_set: Boolean(githubToken) });
    } catch (error) {
      console.error('Error updating project settings:', error);
      res.status(500).json({ error: 'Failed to update project settings' } satisfies ApiError);
    }
  },
);

// GET /projects/:id/readme
router.get(
  '/:id/readme',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<GetProjectReadmeResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const content = readProjectReadme(project.repo_folder_path);
      res.json({ content });
    } catch (error) {
      console.error('Error reading project README:', error);
      res.status(500).json({ error: 'Failed to read project README' });
    }
  },
);

// PUT /projects/:id/readme
router.put(
  '/:id/readme',
  validateParams(IdParamsSchema),
  validateBody(UpdateProjectReadmeBodySchema),
  (req: Request, res: Response<UpdateProjectReadmeResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;
      const { content } = req.validated!.body as UpdateProjectReadmeBody;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      writeProjectReadme(project.repo_folder_path, content);
      res.json({ content });
    } catch (error) {
      console.error('Error writing project README:', error);
      res.status(500).json({ error: 'Failed to write project README' });
    }
  },
);

export default router;
