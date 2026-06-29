// Generic instance pool: assigns URLs to tasks using round-robin.
// URL assignment is sticky for the lifetime of the task (acquired on first run,
// released on task completion). AskUserQuestion pauses do not release the URL
// because the subprocess already has ANTHROPIC_BASE_URL set.

export class InstancePool {
  private urls: string[] = [];
  private assignments = new Map<number, string>(); // taskId → url
  private counter = 0;

  setInstances(urls: string[]): void {
    this.urls = [...urls];
  }

  getCount(): number {
    return this.urls.length;
  }

  getUrls(): string[] {
    return [...this.urls];
  }

  // Returns the already-assigned URL for this task, or assigns the next
  // round-robin URL if the task has no assignment yet.
  // Returns null only when no instances are configured.
  acquire(taskId: number): string | null {
    if (this.urls.length === 0) return null;
    const existing = this.assignments.get(taskId);
    if (existing !== undefined) return existing;
    const url = this.urls[this.counter % this.urls.length] as string;
    this.counter++;
    this.assignments.set(taskId, url);
    return url;
  }

  // Returns the currently assigned URL without creating a new assignment.
  getUrl(taskId: number): string | null {
    return this.assignments.get(taskId) ?? null;
  }

  // Called when a task fully completes (not on AskUserQuestion pause).
  release(taskId: number): void {
    this.assignments.delete(taskId);
  }
}

export const localAiPool = new InstancePool();
export const ollamaPool = new InstancePool();
