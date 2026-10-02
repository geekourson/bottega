import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SquashBeforePrSetting from './SquashBeforePrSetting';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: { projects: { getSettings: vi.fn(), updateSettings: vi.fn() } },
}));

const ok = <T,>(body: T) => ({ ok: true, json: async () => body }) as never;

describe('SquashBeforePrSetting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the current value and saves the toggle', async () => {
    vi.mocked(api.projects.getSettings).mockResolvedValue(ok({ github_token_set: false, squash_before_pr: false }));
    vi.mocked(api.projects.updateSettings).mockResolvedValue(ok({ github_token_set: false, squash_before_pr: true }));
    render(<SquashBeforePrSetting projectId={4} />);

    const checkbox = screen.getByTestId('squash-before-pr');
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeChecked());
    expect(api.projects.updateSettings).toHaveBeenCalledWith(4, { squash_before_pr: true });
  });
});
