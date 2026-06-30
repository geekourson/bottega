import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock the database module
vi.mock('../database/db.js', () => ({
  projectsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

// Mock the projectService
vi.mock('../services/projectService.js', () => ({
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn()
}));

// Mock the documentation service
vi.mock('../services/documentation.js', () => ({
  saveConversationUpload: vi.fn(),
  readProjectReadme: vi.fn(),
  writeProjectReadme: vi.fn(),
  readProjectConstraints: vi.fn(),
  writeProjectConstraints: vi.fn()
}));

// Mock the prompt renderer (Tier 2 per-project overrides)
vi.mock('../services/promptRenderer.js', () => ({
  listPromptNames: vi.fn(() => ['implementation', 'review']),
  getPromptDefinition: vi.fn((name: string) =>
    name === 'implementation' || name === 'review'
      ? { name, label: name, kind: 'prompt', file: `${name}.md`, variables: ['taskDocPath', 'taskId'] }
      : null,
  ),
  loadDefault: vi.fn(() => 'DEFAULT'),
  loadPrompt: vi.fn(() => 'EFFECTIVE'),
  hasOverride: vi.fn(() => false),
  hasProjectOverride: vi.fn(() => false),
  loadProjectOverride: vi.fn(() => null),
  saveProjectOverride: vi.fn(() => 123),
  deleteProjectOverride: vi.fn(() => true),
  getProjectOverrideMtime: vi.fn(() => null),
  findUnknownVariables: vi.fn(() => [])
}));

// Mock the upload middleware (no size/extension restrictions)
vi.mock('../middleware/upload.js', async () => {
  const multer = await import('multer');
  return {
    MulterError: multer.default.MulterError,
    upload: multer.default({ storage: multer.default.memoryStorage() })
  };
});

import projectsRoutes from './projects.js';
import { projectsDb } from '../database/db.js';
import { getAllProjects, getProject, updateProject, deleteProject } from '../services/projectService.js';
import {
  saveConversationUpload,
  readProjectConstraints,
  writeProjectConstraints,
} from '../services/documentation.js';
import {
  findUnknownVariables,
  saveProjectOverride,
  deleteProjectOverride,
  getProjectOverrideMtime,
} from '../services/promptRenderer.js';

describe('Projects Routes - Phase 3', () => {
  let app: import("express").Application;
  const testUserId = 1;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create Express app with mocked auth
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: testUserId, username: 'testuser' } as never;
      next();
    });
    app.use('/api/projects', projectsRoutes);
  });

  describe('GET /api/projects', () => {
    it('should return all projects for the user', async () => {
      const mockProjects = [
        { id: 1, user_id: testUserId, name: 'Project 1', repo_folder_path: '/path/1' },
        { id: 2, user_id: testUserId, name: 'Project 2', repo_folder_path: '/path/2' }
      ];
      vi.mocked(getAllProjects).mockReturnValue(mockProjects as never);

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockProjects);
      expect(getAllProjects).toHaveBeenCalledWith(testUserId);
    });

    it('should return empty array when no projects', async () => {
      vi.mocked(getAllProjects).mockReturnValue([]);

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/projects', () => {
    it('should create a new project', async () => {
      const newProject = { id: 1, userId: testUserId, name: 'New Project', repoFolderPath: '/path/new' };
      vi.mocked(projectsDb.create).mockReturnValue(newProject as never);

      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'New Project', repoFolderPath: '/path/new' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(newProject);
      // projectType defaults to 'web' via the zod schema when omitted.
      expect(projectsDb.create).toHaveBeenCalledWith(testUserId, 'New Project', '/path/new', null, 'web');
    });

    it('should pass an explicit projectType through to the DB layer', async () => {
      const newProject = { id: 2, userId: testUserId, name: 'API Project', repoFolderPath: '/path/api' };
      vi.mocked(projectsDb.create).mockReturnValue(newProject as never);

      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'API Project', repoFolderPath: '/path/api', projectType: 'api' });

      expect(response.status).toBe(201);
      expect(projectsDb.create).toHaveBeenCalledWith(testUserId, 'API Project', '/path/api', null, 'api');
    });

    it('should return 400 on an invalid projectType', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'X', repoFolderPath: '/path/x', projectType: 'mobile' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({ repoFolderPath: '/path/new' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
    });

    it('should return 400 if repoFolderPath is missing', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'New Project' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
    });

    it('should return 409 on duplicate repo path', async () => {
      vi.mocked(projectsDb.create).mockImplementation(() => {
        const error = new Error('UNIQUE constraint failed') as Error & { code: string };
        error.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw error;
      });

      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'New Project', repoFolderPath: '/path/existing' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('A project with this repository path already exists');
    });
  });

  describe('GET /api/projects/:id', () => {
    it('should return a project by ID', async () => {
      const mockProject = { id: 1, user_id: testUserId, name: 'Project 1', repo_folder_path: '/path/1' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const response = await request(app).get('/api/projects/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockProject);
      expect(getProject).toHaveBeenCalledWith(1, testUserId);
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/projects/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });

    it('should return 400 for invalid ID', async () => {
      const response = await request(app).get('/api/projects/invalid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('PUT /api/projects/:id', () => {
    it('should update a project', async () => {
      const updatedProject = { id: 1, user_id: testUserId, name: 'Updated Name', repo_folder_path: '/path/1' };
      vi.mocked(updateProject).mockReturnValue(updatedProject as never);

      const response = await request(app)
        .put('/api/projects/1')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(updatedProject);
      expect(updateProject).toHaveBeenCalledWith(1, testUserId, { name: 'Updated Name' });
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(updateProject).mockReturnValue(null);

      const response = await request(app)
        .put('/api/projects/999')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('should delete a project', async () => {
      vi.mocked(deleteProject).mockReturnValue(true);

      const response = await request(app).delete('/api/projects/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(deleteProject).toHaveBeenCalledWith(1, testUserId);
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(deleteProject).mockReturnValue(false);

      const response = await request(app).delete('/api/projects/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });

  describe('POST /api/projects/:id/upload', () => {
    it('should upload file and return file info', async () => {
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(saveConversationUpload).mockReturnValue({
        name: 'test.txt',
        absolutePath: '/path/to/project/tmp/test.txt',
        relativePath: './tmp/test.txt',
        size: 12,
        mimeType: 'text/plain'
      });

      const response = await request(app)
        .post('/api/projects/1/upload')
        .attach('file', Buffer.from('test content'), 'test.txt');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.file.relativePath).toBe('./tmp/test.txt');
      expect(saveConversationUpload).toHaveBeenCalledWith(
        '/path/to/project',
        'test.txt',
        expect.any(Buffer)
      );
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/999/upload')
        .attach('file', Buffer.from('content'), 'test.txt');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });

    it('should return 400 if no file provided', async () => {
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const response = await request(app)
        .post('/api/projects/1/upload')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No file provided');
    });

    it('should return 400 for invalid project ID', async () => {
      const response = await request(app)
        .post('/api/projects/invalid/upload')
        .attach('file', Buffer.from('content'), 'test.txt');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should accept any file type including xlsx', async () => {
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(saveConversationUpload).mockReturnValue({
        name: 'data.xlsx',
        absolutePath: '/path/to/project/tmp/data.xlsx',
        relativePath: './tmp/data.xlsx',
        size: 1024,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });

      const response = await request(app)
        .post('/api/projects/1/upload')
        .attach('file', Buffer.from('xlsx content'), 'data.xlsx');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.file.relativePath).toBe('./tmp/data.xlsx');
    });
  });

  describe('GET /api/projects/:id/constraints', () => {
    it('should return the project constraints content', async () => {
      vi.mocked(getProject).mockReturnValue({ id: 1, user_id: testUserId } as never);
      vi.mocked(readProjectConstraints).mockReturnValue('Never touch billing.');

      const response = await request(app).get('/api/projects/1/constraints');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ content: 'Never touch billing.' });
      expect(readProjectConstraints).toHaveBeenCalledWith(1);
    });

    it('should return 404 when the project is not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined as never);

      const response = await request(app).get('/api/projects/999/constraints');

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/projects/:id/constraints', () => {
    it('should persist the constraints content', async () => {
      vi.mocked(getProject).mockReturnValue({ id: 1, user_id: testUserId } as never);

      const response = await request(app)
        .put('/api/projects/1/constraints')
        .send({ content: 'All prices in cents.' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ content: 'All prices in cents.' });
      expect(writeProjectConstraints).toHaveBeenCalledWith(1, 'All prices in cents.');
    });

    it('should return 400 when content is missing', async () => {
      vi.mocked(getProject).mockReturnValue({ id: 1, user_id: testUserId } as never);

      const response = await request(app).put('/api/projects/1/constraints').send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('per-project prompt overrides', () => {
    beforeEach(() => {
      vi.mocked(getProject).mockReturnValue({ id: 1, user_id: testUserId } as never);
    });

    it('GET /:id/prompts lists prompts with override state', async () => {
      const response = await request(app).get('/api/projects/1/prompts');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({
        name: 'implementation',
        hasProjectOverride: false,
        hasGlobalOverride: false,
      });
    });

    it('GET /:id/prompts/:name returns default + effective + override state', async () => {
      const response = await request(app).get('/api/projects/1/prompts/implementation');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        name: 'implementation',
        defaultContent: 'DEFAULT',
        effectiveContent: 'EFFECTIVE',
        projectContent: null,
        variables: ['taskDocPath', 'taskId'],
      });
    });

    it('GET /:id/prompts/:name returns 404 for an unknown prompt', async () => {
      const response = await request(app).get('/api/projects/1/prompts/nope');
      expect(response.status).toBe(404);
    });

    it('PUT /:id/prompts/:name saves the project override', async () => {
      const response = await request(app)
        .put('/api/projects/1/prompts/implementation')
        .send({ content: 'CUSTOM {{taskId}}' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ name: 'implementation', mtime: 123, hasProjectOverride: true });
      expect(saveProjectOverride).toHaveBeenCalledWith('implementation', 1, 'CUSTOM {{taskId}}');
    });

    it('PUT /:id/prompts/:name rejects unknown template variables with 400', async () => {
      vi.mocked(findUnknownVariables).mockReturnValueOnce(['bogus']);

      const response = await request(app)
        .put('/api/projects/1/prompts/implementation')
        .send({ content: 'has {{bogus}}' });

      expect(response.status).toBe(400);
      expect(response.body.unknownVariables).toEqual(['bogus']);
      expect(saveProjectOverride).not.toHaveBeenCalled();
    });

    it('PUT /:id/prompts/:name returns 409 on a stale expectedMtime', async () => {
      vi.mocked(getProjectOverrideMtime).mockReturnValueOnce(999);

      const response = await request(app)
        .put('/api/projects/1/prompts/implementation')
        .send({ content: 'CUSTOM', expectedMtime: 1 });

      expect(response.status).toBe(409);
    });

    it('DELETE /:id/prompts/:name removes the project override', async () => {
      const response = await request(app).delete('/api/projects/1/prompts/implementation');

      expect(response.status).toBe(204);
      expect(deleteProjectOverride).toHaveBeenCalledWith('implementation', 1);
    });
  });
});
