/**
 * AgentPipeline.tsx — compact pipeline stepper for board task cards.
 *
 * Shows the state of each workflow step (planification → implementation →
 * review → refinement → PR, or a single YOLO step) at a glance, so the board
 * tells you which stages are done, running, or waiting without opening the task.
 */

import React, { useMemo } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AgentRunRow, AgentRunStatus, AgentType } from '../../../shared/types/db';

interface StepConfig {
  type: AgentType;
  label: string;
  short: string;
}

const PIPELINE_STEPS: StepConfig[] = [
  { type: 'planification', label: 'Planification', short: 'P' },
  { type: 'implementation', label: 'Implementation', short: 'I' },
  { type: 'review', label: 'Review', short: 'R' },
  { type: 'refinement', label: 'Refinement', short: 'Rf' },
  { type: 'pr', label: 'PR', short: 'PR' },
];

const YOLO_STEPS: StepConfig[] = [{ type: 'yolo', label: 'YOLO', short: 'Y' }];

// "not-started" is our own state for a step that has no run yet.
type StepState = AgentRunStatus | 'not-started';

/** Latest run per agent type — highest id wins (autoincrement = most recent). */
function latestStatusByType(runs: AgentRunRow[]): Map<AgentType, AgentRunStatus> {
  const latest = new Map<AgentType, AgentRunRow>();
  for (const run of runs) {
    const prev = latest.get(run.agent_type);
    if (!prev || run.id > prev.id) latest.set(run.agent_type, run);
  }
  const out = new Map<AgentType, AgentRunStatus>();
  for (const [type, run] of latest) out.set(type, run.status);
  return out;
}

const STATE_STYLES: Record<StepState, string> = {
  completed: 'bg-emerald-500 border-emerald-500 text-white',
  running: 'bg-blue-500 border-blue-500 text-white',
  failed: 'bg-red-500 border-red-500 text-white',
  blocked: 'bg-red-600 border-red-600 text-white',
  pending: 'bg-amber-400 border-amber-400 text-white',
  'not-started': 'bg-muted border-border text-muted-foreground',
};

const STATE_LABEL: Record<StepState, string> = {
  completed: 'Completed',
  running: 'Running',
  failed: 'Failed',
  blocked: 'Blocked',
  pending: 'Pending',
  'not-started': 'Not started',
};

export interface AgentPipelineProps {
  agentRuns?: AgentRunRow[] | undefined;
  yoloMode?: boolean | undefined;
  className?: string | undefined;
}

function AgentPipeline({ agentRuns = [], yoloMode = false, className }: AgentPipelineProps) {
  const steps = yoloMode ? YOLO_STEPS : PIPELINE_STEPS;
  const statusByType = useMemo(() => latestStatusByType(agentRuns), [agentRuns]);

  // Nothing has ever run on this task — don't clutter the card.
  if (agentRuns.length === 0) return null;

  return (
    <div
      className={cn('flex items-center gap-1', className)}
      data-testid="agent-pipeline"
      aria-label="Agent pipeline progress"
    >
      {steps.map((step, i) => {
        const state: StepState = statusByType.get(step.type) ?? 'not-started';
        const isRunning = state === 'running';
        return (
          <React.Fragment key={step.type}>
            {i > 0 && <span className="h-px w-1.5 bg-border flex-shrink-0" aria-hidden />}
            <span
              title={`${step.label}: ${STATE_LABEL[state]}`}
              data-testid={`pipeline-step-${step.type}`}
              data-state={state}
              className={cn(
                'inline-flex items-center justify-center rounded-full border',
                'h-4 min-w-4 px-1 text-[9px] font-bold leading-none',
                STATE_STYLES[state],
              )}
            >
              {state === 'completed' ? (
                <Check className="w-2.5 h-2.5" />
              ) : isRunning ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : state === 'failed' || state === 'blocked' ? (
                <X className="w-2.5 h-2.5" />
              ) : (
                step.short
              )}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default AgentPipeline;
