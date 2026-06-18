/**
 * useDesktopNotifications - Notifications bureau macOS/navigateur
 *
 * Demande la permission Notification au premier rendu, puis déclenche
 * des notifications système sur les événements WebSocket importants :
 * - agent-run-updated (completed) → planification/review/PR terminé
 * - awaiting-user-answer → question d'agent en attente
 * - task-blocked → tâche bloquée après max itérations
 */

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { TaskRow } from '../../shared/types/db';
import type { ServerMessageOf } from '../../shared/websocket/messages';

const AGENT_LABELS: Record<string, string> = {
  planification: 'Planification',
  implementation: 'Implémentation',
  review: 'Revue',
  refinement: 'Raffinement',
  pr: 'Pull Request',
  yolo: 'YOLO',
  'ux-design': 'Design UX',
};

function notify(title: string, body: string, icon = '/favicon.ico') {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (localStorage.getItem('desktop-notifications-enabled') === 'false') return;
  try {
    new Notification(title, { body, icon });
  } catch {
    // Safari peut rejeter si la page n'est pas au premier plan
  }
}

export function useDesktopNotifications(tasks: TaskRow[]): void {
  const { subscribe, unsubscribe } = useWebSocket();
  // Map taskId → title pour enrichir les messages
  const taskMapRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    taskMapRef.current = new Map(tasks.map((t) => [t.id, t.title || `Tâche ${t.id}`]));
  }, [tasks]);

  useEffect(() => {
    if (!subscribe || !unsubscribe) return;

    const handleAgentRunUpdated = (msg: ServerMessageOf<'agent-run-updated'>) => {
      const { taskId, agentRun } = msg;
      if (!agentRun || agentRun.status !== 'completed') return;
      const taskName = taskMapRef.current.get(taskId) ?? `Tâche ${taskId}`;
      const agentLabel = AGENT_LABELS[agentRun.agent_type] ?? agentRun.agent_type;
      notify(`${agentLabel} terminée`, taskName);
    };

    const handleAwaitingAnswer = (msg: ServerMessageOf<'awaiting-user-answer'>) => {
      const { taskId } = msg;
      if (!taskId) return;
      const taskName = taskMapRef.current.get(taskId) ?? `Tâche ${taskId}`;
      notify('Question en attente', taskName);
    };

    const handleTaskBlocked = (msg: ServerMessageOf<'task-blocked'>) => {
      const { taskId } = msg;
      const taskName = taskMapRef.current.get(taskId) ?? `Tâche ${taskId}`;
      notify('Tâche bloquée', taskName);
    };

    subscribe('agent-run-updated', handleAgentRunUpdated);
    subscribe('awaiting-user-answer', handleAwaitingAnswer);
    subscribe('task-blocked', handleTaskBlocked);

    return () => {
      unsubscribe('agent-run-updated', handleAgentRunUpdated);
      unsubscribe('awaiting-user-answer', handleAwaitingAnswer);
      unsubscribe('task-blocked', handleTaskBlocked);
    };
  }, [subscribe, unsubscribe]);
}
