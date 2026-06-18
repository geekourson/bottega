/**
 * BoardView.tsx - Kanban Board View for Project Tasks
 *
 * Main board container displaying tasks in 4 columns:
 * - Pending
 * - In Progress
 * - In Review
 * - Completed
 *
 * Features:
 * - Responsive layout: horizontal scroll-snap on mobile, 4-column grid on desktop
 * - Header with breadcrumb navigation and "New Task" button
 * - Loads task documentation and conversation counts
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Plus,
  Columns,
  Settings,
  Server,
  X,
  Loader2,
  MessageCircleQuestion,
  BrainCircuit,
  Play,
} from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { useTaskContext } from '../../contexts/TaskContext';
import { useClaudeAuth } from '../../contexts/ClaudeAuthContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { api, authenticatedFetch } from '../../utils/api';
import { useTasksLiveSubscriptions } from '../../hooks/useTasksLiveSubscriptions';
import BoardColumn from './BoardColumn';
import TaskForm from '../TaskForm';
import AskQuestionModal, { type AskQuestionPayload } from '../AskQuestionModal';
import type { AgentRunRow, ProjectRow, TaskRow, TaskStatus } from '../../../shared/types/db';
import type { ServerMessageOf } from '../../../shared/websocket/messages';
import type { CreateTaskRequest } from '../../../shared/api/tasks';
import type { WebServerStatusSuccess } from '../../../shared/api/projects';
import { useDesktopNotifications } from '../../hooks/useDesktopNotifications';

interface CreateTaskFormPayload {
  title: string;
  documentation?: string;
  yolo_mode?: boolean;
  ux_review_required?: boolean;
}

interface ActionResult {
  success: boolean;
  error?: string;
}

export interface BoardViewProps {
  className?: string;
  project: ProjectRow | null;
}

type TasksByStatus = Record<TaskStatus, TaskRow[]>;

function BoardView({ className, project }: BoardViewProps) {
  const navigate = useNavigate();
  const { requireClaudeAuth } = useClaudeAuth();
  const {
    tasks,
    isLoadingTasks,
    createTask,
    updateTask,
    deleteTask,
    isTaskLive,
    isTaskAwaitingQuestion,
    loadTasks,
  } = useTaskContext();

  // Notifications desktop
  useDesktopNotifications(tasks);

  // Drag state
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);

  // Task form modal state
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // Ask Question modal state
  const [showAskQuestion, setShowAskQuestion] = useState(false);
  const [isAsking, setIsAsking] = useState(false);

  // PO session state
  const [isStartingPoSession, setIsStartingPoSession] = useState(false);

  // Batch "run all pending agents" state
  const [isStartingPending, setIsStartingPending] = useState(false);

  // Subscribe to task-channel events for every task currently displayed on
  // the board so the per-card Live indicator keeps updating between REST
  // snapshots. After the WS scoping change, task events no longer arrive
  // for un-subscribed tasks.
  const visibleTaskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  useTasksLiveSubscriptions(visibleTaskIds);

  // Task documentation cache
  const [taskDocs, setTaskDocs] = useState<Record<number, string>>({});
  const [taskConversationCounts, setTaskConversationCounts] = useState<Record<number, number>>({});
  const [taskAgentRuns, setTaskAgentRuns] = useState<Record<number, AgentRunRow[]>>({});
  const [isLoadingTaskData, setIsLoadingTaskData] = useState(false);

  const { subscribe, unsubscribe } = useWebSocket();

  // Web server status
  const [webServerStatus, setWebServerStatus] = useState<WebServerStatusSuccess | null>(null);
  const [isSwitchingServer, setIsSwitchingServer] = useState(false);

  // Handler to reset server back to main repository
  const handleResetServer = async () => {
    if (!project || isSwitchingServer) return;

    setIsSwitchingServer(true);
    try {
      const response = await api.projects.switchWebServer(project.id, null);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setWebServerStatus((prev) =>
            prev ? { ...prev, activeTaskId: null } : prev
          );
        }
      }
    } catch (error) {
      console.error('Error resetting server:', error);
    } finally {
      setIsSwitchingServer(false);
    }
  };

  // Load web server status
  useEffect(() => {
    const loadWebServerStatus = async () => {
      if (!project) {
        setWebServerStatus(null);
        return;
      }
      try {
        const response = await api.projects.getWebServer(project.id);
        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            setWebServerStatus(data);
          } else {
            setWebServerStatus(null);
          }
        }
      } catch (error) {
        console.error('Error loading web server status:', error);
        setWebServerStatus(null);
      }
    };
    void loadWebServerStatus();
  }, [project]);

  // Group tasks by status
  const tasksByStatus = useMemo<TasksByStatus>(() => {
    const grouped: TasksByStatus = {
      pending: [],
      in_progress: [],
      in_review: [],
      completed: [],
    };

    tasks.forEach((task) => {
      const status = task.status || 'pending';
      if (grouped[status]) {
        grouped[status].push(task);
      } else {
        grouped.pending.push(task);
      }
    });

    // Sort completed tasks by completed_at DESC (most recent first)
    grouped.completed.sort((a, b) => {
      const dateA = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const dateB = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return dateB - dateA;
    });

    return grouped;
  }, [tasks]);

  // Load task documentation and conversation counts
  useEffect(() => {
    const loadTaskData = async () => {
      if (tasks.length === 0) {
        setTaskDocs({});
        setTaskConversationCounts({});
        setTaskAgentRuns({});
        return;
      }

      setIsLoadingTaskData(true);
      const newDocs: Record<number, string> = {};
      const newCounts: Record<number, number> = {};
      const newAgentRuns: Record<number, AgentRunRow[]> = {};

      try {
        await Promise.all(
          tasks.map(async (task) => {
            try {
              // Load documentation
              const docResponse = await api.tasks.getDoc(task.id);
              if (docResponse.ok) {
                const docData = await docResponse.json();
                newDocs[task.id] = docData.content || '';
              }

              // Load conversation count
              const convResponse = await api.conversations.list(task.id);
              if (convResponse.ok) {
                const convData = await convResponse.json();
                // The contract is `ConversationRow[]` but legacy callers also
                // tolerate the older `{ conversations: [...] }` envelope.
                const conversations = Array.isArray(convData)
                  ? convData
                  : (convData as { conversations?: unknown[] })?.conversations ?? [];
                newCounts[task.id] = conversations.length;
              }

              // Load agent runs for the per-card pipeline stepper
              const runsResponse = await api.agentRuns.list(task.id);
              if (runsResponse.ok) {
                newAgentRuns[task.id] = await runsResponse.json();
              }
            } catch (error) {
              console.error(`Error loading data for task ${task.id}:`, error);
            }
          })
        );

        setTaskDocs(newDocs);
        setTaskConversationCounts(newCounts);
        setTaskAgentRuns(newAgentRuns);
      } finally {
        setIsLoadingTaskData(false);
      }
    };

    void loadTaskData();
  }, [tasks]);

  // Keep the per-card pipeline live: upsert the run carried by each
  // agent-run-updated event (task-scoped, delivered for subscribed tasks).
  useEffect(() => {
    if (!subscribe || !unsubscribe) return;

    const handleAgentRunUpdated = (message: ServerMessageOf<'agent-run-updated'>) => {
      const { taskId, agentRun } = message;
      if (!taskId || !agentRun) return;
      setTaskAgentRuns((prev) => {
        const existing = prev[taskId] ?? [];
        const idx = existing.findIndex((r) => r.id === agentRun.id);
        const merged: AgentRunRow =
          idx >= 0
            ? { ...existing[idx], ...agentRun } as AgentRunRow
            : ({ ...agentRun, task_id: taskId } as AgentRunRow);
        const next =
          idx >= 0
            ? existing.map((r) => (r.id === agentRun.id ? merged : r))
            : [...existing, merged];
        return { ...prev, [taskId]: next };
      });
    };

    subscribe('agent-run-updated', handleAgentRunUpdated);
    return () => {
      unsubscribe('agent-run-updated', handleAgentRunUpdated);
    };
  }, [subscribe, unsubscribe]);

  // Handle task click - navigate to task detail view
  const handleTaskClick = useCallback(
    (task: TaskRow) => {
      if (!project) return;
      navigate(`/projects/${project.id}/tasks/${task.id}`);
    },
    [navigate, project]
  );

  // Handle task edit click
  const handleTaskEdit = useCallback(
    (task: TaskRow) => {
      if (!project) return;
      navigate(`/projects/${project.id}/tasks/${task.id}/edit`);
    },
    [navigate, project]
  );

  // Handle task delete click
  const handleTaskDelete = useCallback(
    async (task: TaskRow) => {
      if (
        !window.confirm(
          `Are you sure you want to delete "${task.title || `Task ${task.id}`}"? This will also delete any associated worktree.`
        )
      ) {
        return;
      }
      await deleteTask(task.id);
    },
    [deleteTask]
  );

  // Handle task creation
  const handleCreateTask = useCallback(
    async ({
      title,
      documentation,
      yolo_mode,
      ux_review_required,
    }: CreateTaskFormPayload): Promise<ActionResult> => {
      if (!project) return { success: false, error: 'No project selected' };

      setIsCreatingTask(true);
      try {
        const options: Omit<CreateTaskRequest, 'title' | 'documentation'> = {};
        if (yolo_mode !== undefined) {
          options.yolo_mode = yolo_mode;
        }
        if (ux_review_required !== undefined) {
          options.ux_review_required = ux_review_required;
        }
        const result = await createTask(project.id, title, documentation, options);
        if (result.success) {
          setShowTaskForm(false);
        }
        return result;
      } finally {
        setIsCreatingTask(false);
      }
    },
    [project, createTask]
  );

  // Handle Ask Question: create task + conversation + navigate to chat
  const handleAskQuestion = useCallback(
    async ({ title, question, provider, model }: AskQuestionPayload): Promise<ActionResult> => {
      if (!project) return { success: false, error: 'No project selected' };
      // The Claude-connection gate only applies to the Anthropic backend;
      // OpenAI/OpenCode validate their own credentials server-side.
      if (provider === 'anthropic' && !requireClaudeAuth())
        return { success: false, error: 'Claude authentication required' };

      setIsAsking(true);
      try {
        const createResult = await createTask(project.id, title, '');
        if (!createResult.success || !createResult.task) {
          return { success: false, error: createResult.error || 'Failed to create task' };
        }
        const newTask = createResult.task;

        // Fire status update in parallel — cosmetic, don't block on failure
        api.tasks.update(newTask.id, { status: 'in_progress' }).catch((err) => {
          console.error('Failed to set task status to in_progress:', err);
        });

        // Runs on the explicit (provider, model) picked in the modal.
        const convResponse = await api.conversations.createWithMessage(newTask.id, {
          message: question,
          projectPath: project.repo_folder_path,
          permissionMode: 'bypassPermissions',
          provider,
          model,
        });
        if (!convResponse.ok) {
          const errData = await convResponse
            .json()
            .catch(() => ({}));
          return {
            success: false,
            error: (errData as { error?: string }).error || 'Failed to start conversation',
          };
        }
        const conversation = await convResponse.json();

        setShowAskQuestion(false);
        navigate(
          `/projects/${project.id}/tasks/${newTask.id}/chat/${conversation.id}`,
          { state: { initialMessage: question } }
        );
        return { success: true };
      } catch (err) {
        console.error('Error asking question:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        setIsAsking(false);
      }
    },
    [project, requireClaudeAuth, createTask, navigate]
  );

  // Handle PO session: create PO task + start PO agent + navigate to chat
  const handleStartPoSession = useCallback(async () => {
    if (!project) return;
    if (!requireClaudeAuth()) return;
    setIsStartingPoSession(true);
    try {
      const response = await authenticatedFetch(`/api/projects/${project.id}/po-sessions`, {
        method: 'POST',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('Failed to start PO session:', err);
        return;
      }
      const { taskId, conversationId } = await response.json() as { taskId: number; conversationId: number };
      navigate(`/projects/${project.id}/tasks/${taskId}/chat/${conversationId}`);
    } catch (err) {
      console.error('Error starting PO session:', err);
    } finally {
      setIsStartingPoSession(false);
    }
  }, [project, requireClaudeAuth, navigate]);

  // Handle "Run all pending": batch-start the first pipeline agent on every
  // pending task. The backend auto-chaining then carries each task forward.
  const handleRunAllPending = useCallback(async () => {
    if (!project || isStartingPending) return;
    if (!requireClaudeAuth()) return;

    const pendingCount = tasksByStatus.pending.length;
    if (pendingCount === 0) return;
    if (
      !window.confirm(
        `Start agents on ${pendingCount} pending task${pendingCount > 1 ? 's' : ''}? Each will run planification, then auto-chain through the pipeline.`,
      )
    ) {
      return;
    }

    setIsStartingPending(true);
    try {
      const response = await api.agentRuns.startPending(project.id);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('Failed to start pending agents:', err);
        window.alert((err as { error?: string }).error || 'Failed to start pending agents');
        return;
      }
      const result = await response.json();
      if (result.skipped.length > 0) {
        console.warn('Some pending tasks were skipped:', result.skipped);
      }
      // Backend flips each started task to in_progress synchronously before
      // responding, so refetch to move the cards into the In Progress column
      // immediately (rather than waiting for a manual refresh).
      await loadTasks(project.id);
    } catch (err) {
      console.error('Error starting pending agents:', err);
    } finally {
      setIsStartingPending(false);
    }
  }, [project, isStartingPending, requireClaudeAuth, tasksByStatus.pending.length, loadTasks]);

  // Handle drag & drop status change
  const handleTaskDrop = useCallback(
    async (taskId: number, newStatus: TaskStatus) => {
      setDraggingTaskId(null);
      await updateTask(taskId, { status: newStatus });
    },
    [updateTask],
  );

  const handleTaskDragStart = useCallback((taskId: number) => {
    setDraggingTaskId(taskId);
  }, []);

  // Handle back navigation
  const handleBack = useCallback(() => {
    navigate(`/`);
  }, [navigate]);

  // Handle project edit - navigate to project edit page
  const handleProjectEdit = useCallback(() => {
    if (!project) return;
    navigate(`/projects/${project.id}/edit`);
  }, [navigate, project]);

  if (!project) {
    return null;
  }

  return (
    <div className={cn('h-full flex flex-col bg-gradient-to-b from-background to-muted/20', className)}>
      {/* Header */}
      <div className="flex-shrink-0 bg-background/80 backdrop-blur-sm border-b border-border p-3 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          {/* Left: Back button + project name */}
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="h-8 w-8 p-0 flex-shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-2 min-w-0">
              <Columns className="w-5 h-5 text-primary flex-shrink-0" />
              <h1 className="font-semibold text-lg truncate">{project.name}</h1>
            </div>
          </div>

          {/* Center: Active Web Server indicator */}
          {webServerStatus?.isConfigured && (
            <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-2.5 py-1 rounded-full">
              <Server className="w-3.5 h-3.5" />
              <span>
                Serving:{' '}
                {webServerStatus.activeTaskId
                  ? (() => {
                      const activeTask = tasks.find((t) => t.id === webServerStatus.activeTaskId);
                      return activeTask?.title || `Task #${webServerStatus.activeTaskId}`;
                    })()
                  : 'Main'}
              </span>
              {/* Reset to main button - only show when serving a worktree */}
              {webServerStatus.activeTaskId && (
                <button
                  onClick={handleResetServer}
                  disabled={isSwitchingServer}
                  className="ml-1 p-0.5 rounded hover:bg-muted-foreground/20 transition-colors disabled:opacity-50"
                  title="Switch back to main repository"
                >
                  {isSwitchingServer ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                </button>
              )}
            </div>
          )}

          {/* Right: Edit + New Task buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleProjectEdit}
              className="h-8 w-8 p-0 flex-shrink-0"
              title="Edit project"
            >
              <Settings className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAskQuestion(true)}
              className="flex-shrink-0"
              title="Ask a quick question without creating a full task workflow"
            >
              <MessageCircleQuestion className="w-4 h-4 mr-1.5" />
              Ask Question
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartPoSession}
              disabled={isStartingPoSession}
              className="flex-shrink-0"
              title="Start a PO planning session to propose tasks for the next sprint"
            >
              {isStartingPoSession ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <BrainCircuit className="w-4 h-4 mr-1.5" />
              )}
              {isStartingPoSession ? 'Starting…' : 'Session PO'}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowTaskForm(true)}
              className="flex-shrink-0"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              New Task
            </Button>
          </div>
        </div>

        {/* Project path */}
        <p className="text-xs text-muted-foreground truncate mt-3">
          {project.repo_folder_path}
        </p>
      </div>

      {/* Board columns */}
      <div
        onDragEnd={() => setDraggingTaskId(null)}
        className={cn(
          // Mobile: horizontal scroll-snap
          'flex gap-4 p-4 overflow-x-auto flex-1',
          '[scroll-snap-type:x_mandatory]',
          '[-webkit-overflow-scrolling:touch]',
          'scrollbar-hide',
          // Desktop: 4-column grid
          'md:grid md:grid-cols-4 md:overflow-visible',
          'md:[scroll-snap-type:none]',
          // Improved padding on larger screens
          'lg:gap-6 lg:p-6'
        )}
      >
        <BoardColumn
          status="pending"
          tasks={tasksByStatus.pending}
          taskDocs={taskDocs}
          taskConversationCounts={taskConversationCounts}
          isTaskLive={isTaskLive}
          isTaskAwaitingQuestion={isTaskAwaitingQuestion}
          taskAgentRuns={taskAgentRuns}
          onTaskClick={handleTaskClick}
          onTaskEdit={handleTaskEdit}
          onTaskDelete={handleTaskDelete}
          onTaskDrop={handleTaskDrop}
          onTaskDragStart={handleTaskDragStart}
          draggingTaskId={draggingTaskId}
          headerAction={
            tasksByStatus.pending.length > 0 ? (
              <button
                onClick={handleRunAllPending}
                disabled={isStartingPending}
                className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-primary disabled:opacity-50 transition-colors"
                title="Start agents on all pending tasks"
                data-testid="run-all-pending"
              >
                {isStartingPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Run all
              </button>
            ) : undefined
          }
        />
        <BoardColumn
          status="in_progress"
          tasks={tasksByStatus.in_progress}
          taskDocs={taskDocs}
          taskConversationCounts={taskConversationCounts}
          isTaskLive={isTaskLive}
          isTaskAwaitingQuestion={isTaskAwaitingQuestion}
          taskAgentRuns={taskAgentRuns}
          onTaskClick={handleTaskClick}
          onTaskEdit={handleTaskEdit}
          onTaskDelete={handleTaskDelete}
          onTaskDrop={handleTaskDrop}
          onTaskDragStart={handleTaskDragStart}
          draggingTaskId={draggingTaskId}
        />
        <BoardColumn
          status="in_review"
          tasks={tasksByStatus.in_review}
          taskDocs={taskDocs}
          taskConversationCounts={taskConversationCounts}
          isTaskLive={isTaskLive}
          isTaskAwaitingQuestion={isTaskAwaitingQuestion}
          taskAgentRuns={taskAgentRuns}
          onTaskClick={handleTaskClick}
          onTaskEdit={handleTaskEdit}
          onTaskDelete={handleTaskDelete}
          onTaskDrop={handleTaskDrop}
          onTaskDragStart={handleTaskDragStart}
          draggingTaskId={draggingTaskId}
        />
        <BoardColumn
          status="completed"
          tasks={tasksByStatus.completed}
          taskDocs={taskDocs}
          taskConversationCounts={taskConversationCounts}
          isTaskLive={isTaskLive}
          isTaskAwaitingQuestion={isTaskAwaitingQuestion}
          taskAgentRuns={taskAgentRuns}
          onTaskClick={handleTaskClick}
          onTaskEdit={handleTaskEdit}
          onTaskDelete={handleTaskDelete}
          onTaskDrop={handleTaskDrop}
          onTaskDragStart={handleTaskDragStart}
          draggingTaskId={draggingTaskId}
        />
      </div>

      {/* Loading overlay for tasks */}
      {(isLoadingTasks || isLoadingTaskData) && (
        <div className="absolute inset-0 bg-background/50 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Loading tasks...</span>
          </div>
        </div>
      )}

      {/* Task Form Modal */}
      <TaskForm
        isOpen={showTaskForm}
        onClose={() => setShowTaskForm(false)}
        onSubmit={handleCreateTask}
        projectName={project?.name}
        isSubmitting={isCreatingTask}
      />

      {/* Ask Question Modal */}
      <AskQuestionModal
        isOpen={showAskQuestion}
        onClose={() => setShowAskQuestion(false)}
        onSubmit={handleAskQuestion}
        projectName={project?.name}
        isSubmitting={isAsking}
      />
    </div>
  );
}

export default BoardView;
