import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentPipeline from './AgentPipeline';
import type { AgentRunRow } from '../../../shared/types/db';

vi.mock('lucide-react', () => ({
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

const run = (p: Partial<AgentRunRow>): AgentRunRow => p as unknown as AgentRunRow;

describe('AgentPipeline', () => {
  it('renders nothing when there are no agent runs', () => {
    const { container } = render(<AgentPipeline agentRuns={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the five pipeline steps for a normal task', () => {
    render(<AgentPipeline agentRuns={[run({ id: 1, agent_type: 'planification', status: 'completed' })]} />);

    for (const type of ['planification', 'implementation', 'review', 'refinement', 'pr']) {
      expect(screen.getByTestId(`pipeline-step-${type}`)).toBeInTheDocument();
    }
  });

  it('renders only the YOLO step for a YOLO task', () => {
    render(
      <AgentPipeline
        yoloMode
        agentRuns={[run({ id: 1, agent_type: 'yolo', status: 'running' })]}
      />,
    );

    expect(screen.getByTestId('pipeline-step-yolo')).toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-step-planification')).not.toBeInTheDocument();
  });

  it('reflects each step state', () => {
    render(
      <AgentPipeline
        agentRuns={[
          run({ id: 1, agent_type: 'planification', status: 'completed' }),
          run({ id: 2, agent_type: 'implementation', status: 'running' }),
          run({ id: 3, agent_type: 'review', status: 'failed' }),
        ]}
      />,
    );

    expect(screen.getByTestId('pipeline-step-planification').dataset.state).toBe('completed');
    expect(screen.getByTestId('pipeline-step-implementation').dataset.state).toBe('running');
    expect(screen.getByTestId('pipeline-step-review').dataset.state).toBe('failed');
    // Steps with no run fall back to "not-started".
    expect(screen.getByTestId('pipeline-step-refinement').dataset.state).toBe('not-started');
    expect(screen.getByTestId('pipeline-step-pr').dataset.state).toBe('not-started');
  });

  it('uses the latest run per type (highest id wins)', () => {
    render(
      <AgentPipeline
        agentRuns={[
          run({ id: 5, agent_type: 'implementation', status: 'failed' }),
          run({ id: 9, agent_type: 'implementation', status: 'completed' }),
        ]}
      />,
    );

    expect(screen.getByTestId('pipeline-step-implementation').dataset.state).toBe('completed');
  });
});
