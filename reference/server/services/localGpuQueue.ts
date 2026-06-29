// N-concurrent execution queue for local GPU providers (ollama, local-ai).
// Multiple tasks can run simultaneously when multiple instances are configured.
// When all slots are occupied, tasks queue and start automatically when a slot frees.
//
// Re-entrant: the same task can call setActive() multiple times (agent chaining)
// without releasing its slot.
//
// Two entry types share a single FIFO queue:
//   'start'  — a new task to run
//   'resume' — a paused task re-entering after AskUserQuestion

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

export class LocalGpuQueue {
  private activeTasks = new Set<number>();
  private maxConcurrent = 1;
  private queue: InternalEntry[] = [];

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  isLocalProvider(provider: string): boolean {
    return provider === 'ollama' || provider === 'local-ai';
  }

  // For backward compat: returns first active task or null.
  getActiveTaskId(): number | null {
    const iter = this.activeTasks.values().next();
    return iter.done ? null : iter.value;
  }

  isActive(taskId: number): boolean {
    return this.activeTasks.has(taskId);
  }

  // True if taskId already holds a slot, or a slot is free.
  canRunNow(taskId: number): boolean {
    return this.activeTasks.has(taskId) || this.activeTasks.size < this.maxConcurrent;
  }

  // Claim a slot for taskId. Safe to call multiple times for the same task.
  setActive(taskId: number): void {
    this.activeTasks.add(taskId);
  }

  enqueue(entry: QueuedTask): void {
    if (!this.queue.some((e) => e.taskId === entry.taskId)) {
      this.queue.push({ kind: 'start', ...entry });
    }
  }

  // Add a 'resume' entry and wait until a slot is free for this task.
  waitToResume(taskId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ kind: 'resume', taskId, resolve });
    });
  }

  // Release taskId's slot. If capacity is now available, dequeues and returns
  // the next eligible task for the caller to start via startAgentRun.
  release(taskId: number, isEligible: (taskId: number) => boolean = () => true): QueuedTask | null {
    if (!this.activeTasks.has(taskId)) return null;
    this.activeTasks.delete(taskId);

    if (this.activeTasks.size >= this.maxConcurrent) return null;

    const initialLength = this.queue.length;
    let attempts = 0;

    while (this.queue.length > 0 && attempts < initialLength) {
      const candidate = this.queue.shift()!;
      if (isEligible(candidate.taskId)) {
        this.activeTasks.add(candidate.taskId);
        if (candidate.kind === 'resume') {
          candidate.resolve();
          return null;
        }
        return { taskId: candidate.taskId, agentType: candidate.agentType, options: candidate.options };
      }
      this.queue.push(candidate);
      attempts++;
    }

    return null;
  }

  removeFromQueue(taskId: number): void {
    this.queue = this.queue.filter((e) => e.taskId !== taskId);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getQueuedTaskIds(): number[] {
    return [...new Set(this.queue.map((e) => e.taskId))];
  }
}

// Two separate queues: one per local provider.
export const localAiGpuQueue = new LocalGpuQueue();
export const ollamaGpuQueue = new LocalGpuQueue();

// Facade kept for backward compat + convenience.
export const localGpuQueue = {
  isLocalProvider: (provider: string): boolean =>
    provider === 'ollama' || provider === 'local-ai',
  for: (provider: string): LocalGpuQueue =>
    provider === 'ollama' ? ollamaGpuQueue : localAiGpuQueue,
  // Combined queue length/IDs for the frontend badge.
  getQueueLength: (): number =>
    localAiGpuQueue.getQueueLength() + ollamaGpuQueue.getQueueLength(),
  getQueuedTaskIds: (): number[] => [
    ...localAiGpuQueue.getQueuedTaskIds(),
    ...ollamaGpuQueue.getQueuedTaskIds(),
  ],
};
