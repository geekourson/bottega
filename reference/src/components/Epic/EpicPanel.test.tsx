import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EpicPanel from './EpicPanel';
import { api } from '../../utils/api';
import type { EpicOverviewResponse } from '../../../shared/api/epics';
import type { TaskRow } from '../../../shared/types/db';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('../../utils/api', () => ({
  api: {
    epics: {
      get: vi.fn(),
      approveBreakdown: vi.fn(),
    },
  },
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));

vi.mock('../../contexts/TaskContext', () => ({
  useTaskContext: () => ({ isTaskLive: () => false, liveTaskIds: new Set() }),
}));

vi.mock('../../hooks/useTasksLiveSubscriptions', () => ({
  useTasksLiveSubscriptions: vi.fn(),
}));

const ok = <T,>(body: T) => ({ ok: true, status: 200, json: async () => body }) as never;

const epic = {
  id: 10,
  project_id: 1,
  title: 'Invoice PDF',
  status: 'pending',
  planification_complete: 1,
  breakdown_approved: 0,
} as unknown as TaskRow;

const proposed: EpicOverviewResponse = {
  epic,
  umbrella: { id: 1, name: 'Product' },
  childProjects: [
    { id: 2, name: 'api' },
    { id: 3, name: 'front' },
  ],
  breakdown: {
    summary: 'Export invoices as PDF',
    sharedContract: 'GET /invoices/:id/pdf',
    subtasks: [
      { key: 'api-endpoint', projectId: 2, title: 'PDF endpoint', description: 'Serve it', dependsOn: [] },
      { key: 'front-button', projectId: 3, title: 'Export button', description: 'Add it', dependsOn: ['api-endpoint'] },
    ],
  },
  breakdownErrors: [],
  subtasks: [],
};

const subtask = (id: number, projectId: number, title: string, extra: Partial<TaskRow> = {}) =>
  ({ id, project_id: projectId, title, status: 'in_progress', pr_agent_complete: 0, waiting_on_dependencies: 0, ...extra }) as TaskRow;

const approved: EpicOverviewResponse = {
  ...proposed,
  epic: { ...epic, breakdown_approved: 1, status: 'in_progress' },
  subtasks: [
    { task: subtask(20, 2, 'PDF endpoint', { status: 'completed' }), project: { id: 2, name: 'api' }, dependsOn: [] },
    {
      task: subtask(21, 3, 'Export button', { waiting_on_dependencies: 1 }),
      project: { id: 3, name: 'front' },
      dependsOn: [{ id: 20, title: 'PDF endpoint', status: 'completed', project: { id: 2, name: 'api' }, satisfied: true }],
    },
  ],
};

const renderPanel = (task: TaskRow = epic) =>
  render(
    <MemoryRouter>
      <EpicPanel epic={task} isBreakdownRunning={false} />
    </MemoryRouter>,
  );

describe('EpicPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the proposed breakdown grouped by child project', async () => {
    vi.mocked(api.epics.get).mockResolvedValue(ok(proposed));
    renderPanel();

    expect(await screen.findByText('Proposed breakdown')).toBeInTheDocument();
    expect(screen.getByText('PDF endpoint')).toBeInTheDocument();
    expect(screen.getByText('After: PDF endpoint')).toBeInTheDocument();
    expect(screen.getByText(/Approve & create 2 sub-tasks/)).toBeInTheDocument();
  });

  it('approves the breakdown with the planning option', async () => {
    vi.mocked(api.epics.get).mockResolvedValueOnce(ok(proposed)).mockResolvedValue(ok(approved));
    vi.mocked(api.epics.approveBreakdown).mockResolvedValue(ok({ epic, subtasks: [], planningErrors: [] }));
    renderPanel();

    fireEvent.click(await screen.findByTestId('approve-breakdown'));

    await waitFor(() => expect(api.epics.approveBreakdown).toHaveBeenCalledWith(10, true));
    expect(await screen.findByText('Sub-tasks across repositories')).toBeInTheDocument();
  });

  it('disables approval until the breakdown agent validated its file', async () => {
    const pendingEpic = { ...epic, planification_complete: 0 } as TaskRow;
    vi.mocked(api.epics.get).mockResolvedValue(ok({ ...proposed, epic: pendingEpic }));
    renderPanel(pendingEpic);

    expect(await screen.findByTestId('approve-breakdown')).toBeDisabled();
  });

  it('lists sub-tasks across repositories and opens them in their child project', async () => {
    vi.mocked(api.epics.get).mockResolvedValue(ok(approved));
    renderPanel(approved.epic);

    expect(await screen.findByText('1/2 completed')).toBeInTheDocument();
    expect(screen.getByText(/Waiting on/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('epic-subtask-21'));
    expect(navigate).toHaveBeenCalledWith('/projects/3/tasks/21');

    fireEvent.click(screen.getByTitle("Open front's board"));
    expect(navigate).toHaveBeenCalledWith('/projects/3');
  });

  it('offers to run the breakdown agent when there is no breakdown yet', async () => {
    const freshEpic = { ...epic, planification_complete: 0 } as TaskRow;
    vi.mocked(api.epics.get).mockResolvedValue(
      ok({ ...proposed, epic: freshEpic, breakdown: null, breakdownErrors: ['breakdown file not found: /x'] }),
    );
    const onRunBreakdown = vi.fn();
    render(
      <MemoryRouter>
        <EpicPanel epic={freshEpic} isBreakdownRunning={false} onRunBreakdown={onRunBreakdown} />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId('run-breakdown'));
    await waitFor(() => expect(onRunBreakdown).toHaveBeenCalled());
  });

  it('hides the run button while the umbrella has no child project', async () => {
    const freshEpic = { ...epic, planification_complete: 0 } as TaskRow;
    vi.mocked(api.epics.get).mockResolvedValue(
      ok({ ...proposed, epic: freshEpic, childProjects: [], breakdown: null, breakdownErrors: ['breakdown file not found: /x'] }),
    );
    render(
      <MemoryRouter>
        <EpicPanel epic={freshEpic} isBreakdownRunning={false} onRunBreakdown={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/has no child projects yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('run-breakdown')).not.toBeInTheDocument();
  });

  it('shows validation errors of an invalid breakdown file', async () => {
    vi.mocked(api.epics.get).mockResolvedValue(
      ok({ ...proposed, breakdown: null, breakdownErrors: ['the dependencies form a cycle'] }),
    );
    renderPanel();

    expect(await screen.findByText('the dependencies form a cycle')).toBeInTheDocument();
  });
});
