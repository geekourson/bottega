import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChildProjectsModal from './ChildProjectsModal';
import { api } from '../../utils/api';
import type { ProjectRow } from '../../../shared/types/db';

vi.mock('../../utils/api', () => ({
  api: { projects: { setChildren: vi.fn() } },
}));

const project = (id: number, name: string, extra: Partial<ProjectRow> = {}) =>
  ({ id, name, repo_folder_path: `/repos/${name}`, is_umbrella: 0, parent_project_id: null, ...extra }) as ProjectRow;

const umbrella = project(1, 'Product', { is_umbrella: 1 });
const projects = [
  umbrella,
  project(2, 'api', { parent_project_id: 1 }),
  project(3, 'front'),
  project(4, 'elsewhere', { parent_project_id: 5 }),
  project(5, 'Other umbrella', { is_umbrella: 1 }),
];

describe('ChildProjectsModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only eligible projects, with current children checked', () => {
    render(<ChildProjectsModal isOpen umbrella={umbrella} projects={projects} onClose={vi.fn()} onSaved={vi.fn()} />);

    const list = screen.getByTestId('child-projects-list');
    expect(list).toHaveTextContent('api');
    expect(list).toHaveTextContent('front');
    expect(list).not.toHaveTextContent('elsewhere');
    expect(list).not.toHaveTextContent('Other umbrella');
    expect(screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([true, false]);
  });

  it('offers projects whose former umbrella was deleted', () => {
    const orphan = project(6, 'orphan', { parent_project_id: 42 }); // umbrella 42 no longer listed
    render(
      <ChildProjectsModal isOpen umbrella={umbrella} projects={[...projects, orphan]} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByTestId('child-projects-list')).toHaveTextContent('orphan');
  });

  it('saves the full list of children', async () => {
    vi.mocked(api.projects.setChildren).mockResolvedValue({ ok: true, json: async () => [] } as never);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ChildProjectsModal isOpen umbrella={umbrella} projects={projects} onClose={onClose} onSaved={onSaved} />);

    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(api.projects.setChildren).toHaveBeenCalledWith(1, [2, 3]));
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error', async () => {
    vi.mocked(api.projects.setChildren).mockResolvedValue({
      ok: false,
      json: async () => ({ error: '"front" already belongs to another umbrella project' }),
    } as never);
    render(<ChildProjectsModal isOpen umbrella={umbrella} projects={projects} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/already belongs to another umbrella/)).toBeInTheDocument();
  });
});
