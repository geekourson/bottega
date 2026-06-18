/**
 * TaskDetailPage.tsx - Task Detail Page Wrapper
 *
 * Loads project, task, conversations, and documentation from URL params.
 * Renders the TaskDetailView component.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import TaskDetailView from '../components/TaskDetailView';
import NewConversationModal from '../components/NewConversationModal';
import { useTaskContext } from '../contexts/TaskContext';
import { useToast } from '../contexts/ToastContext';
import { useClaudeAuth } from '../contexts/ClaudeAuthContext';
import { useTaskSubscription } from '../hooks/useTaskSubscription';
import { api } from '../utils/api';
import type { ProjectRow, TaskRow, TaskStatus, AgentType } from '../../shared/types/db';

interface ActionResultLike {
  success?: boolean;
  error?: string;
  task?: TaskRow;
}

type ConversationCreated = Record<string, unknown> & {
  __initialMessage?: string;
};

function TaskDetailPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { openAuthModal } = useClaudeAuth();
  const {
    projects,
    tasks,
    conversations,
    taskDoc,
    agentRuns,
    loadProjects,
    loadTasks,
    loadConversations,
    loadTaskDoc,
    loadAgentRuns,
    updateTask,
    deleteConversation,
    renameConversation,
    saveTaskDoc,
    isLoadingProjects,
    isLoadingConversations,
    isLoadingTaskDoc,
    isLoadingAgentRuns
  } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);

  // Subscribe to real-time task updates via WebSocket
  useTaskSubscription(task?.id ?? null);

  // Load project data
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        if (projects.length === 0 && !isLoadingProjects) {
          await loadProjects();
        }
      } finally {
        setIsLoading(false);
      }
    };

    void loadData();
  }, [projectId, loadProjects, projects.length, isLoadingProjects]);

  // Find project and load tasks
  useEffect(() => {
    if (projects.length > 0 && projectId) {
      const foundProject = projects.find(p => p.id === parseInt(projectId, 10));
      if (foundProject) {
        setProject(foundProject);
        void loadTasks(foundProject.id);
      } else {
        navigate(`/`, { replace: true });
      }
    }
  }, [projects, projectId, loadTasks, navigate]);

  // Find task and load its data
  useEffect(() => {
    if (tasks.length > 0 && project && taskId) {
      const foundTask = tasks.find(t => t.id === parseInt(taskId, 10));
      if (foundTask) {
        setTask(foundTask);
        // Load task-related data
        void loadConversations(foundTask.id);
        void loadTaskDoc(foundTask.id);
        void loadAgentRuns(foundTask.id);
      } else {
        // Task not found, redirect to board
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }
  }, [tasks, taskId, project, projectId, loadConversations, loadTaskDoc, loadAgentRuns, navigate]);

  // Navigation handlers
  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}`);
  }, [navigate, projectId]);

  const handleProjectClick = useCallback(() => {
    navigate(`/projects/${projectId}`);
  }, [navigate, projectId]);

  const handleHomeClick = useCallback(() => {
    navigate(`/`);
  }, [navigate]);

  // Task handlers
  const handleSaveTaskDoc = useCallback(async (content: string) => {
    if (!task) return { success: false, error: 'No task selected' };
    return await saveTaskDoc(task.id, content);
  }, [task, saveTaskDoc]);

  const handleStatusChange = useCallback(async (taskIdParam: number, newStatus: TaskStatus) => {
    return await updateTask(taskIdParam, { status: newStatus });
  }, [updateTask]);

  const handleUpdateTaskFlags = useCallback(async (taskIdParam: number, patch: { yolo_mode?: boolean; ux_review_required?: boolean }) => {
    const res = await api.tasks.update(taskIdParam, patch);
    if (res.ok) {
      const updatedTask = await res.json();
      setTask(updatedTask);
    }
  }, [setTask]);

  const handleEditDocumentation = useCallback(() => {
    if (task) {
      navigate(`/projects/${projectId}/tasks/${taskId}/edit`);
    }
  }, [task, navigate, projectId, taskId]);

  const handleShowDocumentation = useCallback(() => {
    if (task) {
      navigate(`/projects/${projectId}/tasks/${taskId}/show`);
    }
  }, [task, navigate, projectId, taskId]);

  const handleWorkflowCompleteChange = useCallback(async (taskIdParam: number, value: boolean): Promise<ActionResultLike> => {
    try {
      const response = await api.tasks.setWorkflowComplete(taskIdParam, value);
      if (response.ok) {
        const updatedTask = await response.json();
        setTask(updatedTask);
        return { success: true, task: updatedTask };
      } else {
        const error = await response.json() as { error?: string };
        return { success: false, error: error.error || 'Failed to update workflow' };
      }
    } catch (err) {
      console.error('Error updating workflow complete:', err);
      return { success: false, error: (err as Error).message };
    }
  }, []);

  const handleResumeWorkflow = useCallback(async (resumeTaskId: number) => {
    // Agents run on their per-agent provider (any of the three); the server
    // validates that provider's credentials and surfaces a clear error if
    // they're missing — no Claude-specific gate here.
    try {
      const response = await api.tasks.resume(resumeTaskId, false);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          // Refresh task to update workflow_blocked state
          const taskResponse = await api.tasks.get(resumeTaskId);
          if (taskResponse.ok) {
            const updatedTask = await taskResponse.json();
            setTask(updatedTask);
          }
          toast.success('Workflow resumed');
        } else {
          toast.error((data as { error?: string }).error || 'Failed to resume workflow');
        }
      } else {
        const data = await response.json().catch(() => ({})) as { error?: string };
        toast.error(data.error || 'Failed to resume workflow');
      }
    } catch (err) {
      console.error('Error resuming workflow:', err);
      toast.error(`Failed to resume workflow: ${(err as Error).message}`);
    }
  }, [toast]);

  // Conversation handlers
  const handleNewConversation = useCallback(() => {
    if (!task) return;
    // No Claude gate here — the modal lets the user pick any connected
    // provider and only requires Claude auth if they choose Anthropic.
    setShowNewConversationModal(true);
  }, [task]);

  const handleConversationCreated = useCallback((conversation: ConversationCreated) => {
    setShowNewConversationModal(false);
    // Pass initial message via navigation state so ChatPage can display it immediately
    const id = conversation.id as number;
    navigate(`/projects/${projectId}/tasks/${taskId}/chat/${id}`, {
      state: { initialMessage: conversation.__initialMessage }
    });
  }, [navigate, projectId, taskId]);

  const handleCIFixConversationCreated = useCallback((conversation: ConversationCreated) => {
    // Navigate to chat page with the CI fix initial message
    const id = conversation.id as number;
    navigate(`/projects/${projectId}/tasks/${taskId}/chat/${id}`, {
      state: { initialMessage: conversation.__initialMessage }
    });
  }, [navigate, projectId, taskId]);

  const handleResumeConversation = useCallback((conversation: { id: number }) => {
    navigate(`/projects/${projectId}/tasks/${taskId}/chat/${conversation.id}`);
  }, [navigate, projectId, taskId]);

  // Agent handlers
  const handleRunAgent = useCallback(async (agentType: AgentType) => {
    if (!task) return;
    // The agent's configured provider decides which credentials are needed.
    // The server returns PROVIDER_CREDENTIALS_MISSING (handled below) when
    // they're absent, so we don't gate on Claude auth up front.
    try {
      const response = await api.agentRuns.create(task.id, agentType);

      if (response.status === 409) {
        const data = await response.json() as { runningAgent?: { agent_type?: string } };
        toast.warning(`${data.runningAgent?.agent_type || 'An'} agent is already running`);
        return;
      }

      if (response.status === 403) {
        const data = (await response.json()) as {
          error?: string;
          code?: string;
          provider?: 'anthropic' | 'openai' | 'opencode';
        };
        if (data.code === 'PROVIDER_CREDENTIALS_MISSING') {
          // Configured provider has no credentials — pop the unified
          // provider picker so the user can connect whichever provider
          // is missing from one place.
          const providerLabel =
            data.provider === 'openai'
              ? 'OpenAI'
              : data.provider === 'opencode'
                ? 'OpenCode'
                : 'Claude';
          toast.error(data.error || `${providerLabel} credentials required`);
          openAuthModal();
          return;
        }
        toast.error(data.error || `Failed to start ${agentType} agent`);
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        const data = await response.json() as { error?: string };
        toast.error(data.error || `Failed to start ${agentType} agent`);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        toast.error(data.error || `Server error starting ${agentType} agent`);
        return;
      }

      const newRun = await response.json() as { conversation_id?: number | null };
      await loadAgentRuns(task.id);
      await loadConversations(task.id);
      toast.success(`${agentType.charAt(0).toUpperCase() + agentType.slice(1)} agent started`);
      if (newRun.conversation_id) {
        navigate(`/projects/${projectId}/tasks/${taskId}/chat/${newRun.conversation_id}`);
      }
    } catch (err) {
      console.error('Error starting agent:', err);
      toast.error(`Failed to start agent: ${(err as Error).message}`);
    }
  }, [task, openAuthModal, loadAgentRuns, loadConversations, navigate, projectId, taskId, toast]);

  const handleApproveUxDesign = useCallback(async (approveTaskId: number) => {
    // Find the latest ux_design agent run with a conversation
    const uxRun = [...agentRuns]
      .filter(r => r.agent_type === 'ux_design' && r.conversation_id != null)
      .sort((a, b) => b.id - a.id)[0];

    if (!uxRun?.conversation_id) {
      toast.error('No UX design conversation found. Run the UX Design agent first.');
      return;
    }

    // Load messages from the UX design conversation
    let messages: unknown[] = [];
    try {
      const response = await api.conversations.getMessages(uxRun.conversation_id, null, 0);
      if (response.ok) {
        const data = await response.json() as unknown;
        messages = Array.isArray(data) ? data : ((data as { messages?: unknown[] }).messages ?? []);
      }
    } catch (err) {
      toast.error(`Failed to load conversation messages: ${(err as Error).message}`);
      return;
    }

    // Find the last assistant message and extract the design-spec block
    const lastAssistant = [...messages].reverse().find(
      (m): m is { type: string; message: { content: unknown } } =>
        typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'assistant'
    );
    let designSpec = '';
    if (lastAssistant?.message?.content) {
      const content = lastAssistant.message.content;
      const fullText: string = Array.isArray(content)
        ? content
            .filter((b): b is { type: string; text: string } => typeof (b as { text?: unknown }).text === 'string')
            .map(b => b.text)
            .join('')
        : typeof content === 'string'
          ? content
          : '';
      const match = fullText.match(/```design-spec\n([\s\S]*?)```/);
      if (match?.[1]) {
        designSpec = match[1].trim();
      }
    }

    if (!designSpec) {
      toast.error('No design-spec block found in the last UX agent message. Ask the agent to produce one.');
      return;
    }

    try {
      const response = await api.tasks.approveUxDesign(approveTaskId, designSpec);
      if (response.ok) {
        const updatedTask = await response.json() as TaskRow;
        setTask(updatedTask);
        toast.success('UX design approved and written to task doc');
      } else {
        const data = await response.json() as { error?: string };
        toast.error(data.error || 'Failed to approve UX design');
      }
    } catch (err) {
      toast.error(`Failed to approve UX design: ${(err as Error).message}`);
    }
  }, [agentRuns, toast]);

  const handleResetTask = useCallback(async (resetTaskId: number) => {
    try {
      const response = await api.tasks.reset(resetTaskId);
      if (response.ok) {
        await loadAgentRuns(resetTaskId);
        await loadConversations(resetTaskId);
        const taskResponse = await api.tasks.get(resetTaskId);
        if (taskResponse.ok) {
          const updatedTask = await taskResponse.json();
          setTask(updatedTask);
        }
        toast.success('Tâche réinitialisée');
      } else {
        const data = await response.json().catch(() => ({})) as { error?: string };
        toast.error(data.error || 'Échec de la réinitialisation');
      }
    } catch (err) {
      console.error('Error resetting task:', err);
      toast.error(`Échec de la réinitialisation: ${(err as Error).message}`);
    }
  }, [loadAgentRuns, loadConversations, toast]);

  // Loading state
  if (isLoading || isLoadingProjects || !project || !task) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading task...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <TaskDetailView
        project={project}
        task={task}
        taskDoc={taskDoc}
        conversations={conversations}
        isLoadingDoc={isLoadingTaskDoc}
        isLoadingConversations={isLoadingConversations}
        agentRuns={agentRuns}
        isLoadingAgentRuns={isLoadingAgentRuns}
        onRunAgent={handleRunAgent}
        onBack={handleBack}
        onProjectClick={handleProjectClick}
        onHomeClick={handleHomeClick}
        onSaveTaskDoc={handleSaveTaskDoc}
        onEditDocumentation={handleEditDocumentation}
        onShowDocumentation={handleShowDocumentation}
        onStatusChange={handleStatusChange}
        onUpdateTaskFlags={handleUpdateTaskFlags}
        onWorkflowCompleteChange={handleWorkflowCompleteChange}
        onResumeWorkflow={handleResumeWorkflow}
        onApproveUxDesign={handleApproveUxDesign}
        onResetTask={handleResetTask}
        onNewConversation={handleNewConversation}
        onResumeConversation={handleResumeConversation}
        onDeleteConversation={deleteConversation}
        onRenameConversation={renameConversation}
        onCIFixConversationCreated={handleCIFixConversationCreated}
        className="h-full"
      />
      <NewConversationModal
        isOpen={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        project={project}
        taskId={task?.id}
        onConversationCreated={handleConversationCreated}
      />
    </>
  );
}

export default TaskDetailPage;
