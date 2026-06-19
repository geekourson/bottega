// Sequential execution queue for local GPU providers (ollama, local-ai).
// Only one task runs at a time. When a task completes or becomes blocked,
// the next queued task is started automatically.
//
// Re-entrant: the same task can call setActive() multiple times (e.g., during
// agent chaining implementation → review) without releasing the slot.
// The slot is only released by an explicit release() call.
//
// Two entry types share a single FIFO queue:
//   'start'  — a new task to run (from start-pending or manual Run)
//   'resume' — a paused task re-entering after the user answered a question

import type { AgentType } from '@shared/websocket/messages';
import type { StartAgentRunOptions } from './agentRunner.js';

export interface QueuedTask {
  taskId: number;
  agentType: AgentType;
  options: StartAgentRunOptions;
}

type InternalEntry =
  | { kind: 'start'; taskId: number; agentType: AgentType; options: StartAgentRunOptions }
  | { kind: 'resume'; taskId: number; resolve: () => void };

class LocalGpuQueue {
  private activeTaskId: number | null = null;
  private queue: InternalEntry[] = [];

  isLocalProvider(provider: string): boolean {
    return provider === 'ollama' || provider === 'local-ai';
  }

  getActiveTaskId(): number | null {
    return this.activeTaskId;
  }

  // Returns true if taskId can start immediately.
  // Re-entrant: always true when the same task already holds the slot.
  canRunNow(taskId: number): boolean {
    return this.activeTaskId === null || this.activeTaskId === taskId;
  }

  // Mark taskId as the current active task. Safe to call multiple times for
  // the same task (e.g., during agent chaining within a task).
  setActive(taskId: number): void {
    this.activeTaskId = taskId;
  }

  // Enqueue a new task start. Ignores duplicate task entries.
  enqueue(entry: QueuedTask): void {
    if (!this.queue.some((e) => e.taskId === entry.taskId)) {
      this.queue.push({ kind: 'start', ...entry });
    }
  }

  // Add the task to the end of the queue as a resume entry and wait until the
  // GPU is free for it. Used when the user answers an AskUserQuestion and the
  // GPU is busy with another task. Resolves when it's this task's turn.
  waitToResume(taskId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ kind: 'resume', taskId, resolve });
    });
  }

  // Release the active slot. Iterates the queue, skipping entries for which
  // isEligible returns false (moved to end). For 'resume' entries, wakes up
  // the waiting promise and returns null. For 'start' entries, returns the
  // QueuedTask so the caller can launch startAgentRun.
  release(taskId: number, isEligible: (taskId: number) => boolean = () => true): QueuedTask | null {
    if (this.activeTaskId !== taskId) return null;

    const initialLength = this.queue.length;
    let attempts = 0;

    while (this.queue.length > 0 && attempts < initialLength) {
      const candidate = this.queue.shift()!;
      if (isEligible(candidate.taskId)) {
        this.activeTaskId = candidate.taskId;
        if (candidate.kind === 'resume') {
          // Wake up the waiting resolveAskUserQuestion — no startAgentRun needed.
          candidate.resolve();
          return null;
        }
        return { taskId: candidate.taskId, agentType: candidate.agentType, options: candidate.options };
      }
      // Not eligible yet — move to end and try next
      this.queue.push(candidate);
      attempts++;
    }

    this.activeTaskId = null;
    return null;
  }

  removeFromQueue(taskId: number): void {
    this.queue = this.queue.filter((e) => e.taskId !== taskId);
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

// Module-level singleton: one GPU queue per server process.
export const localGpuQueue = new LocalGpuQueue();
