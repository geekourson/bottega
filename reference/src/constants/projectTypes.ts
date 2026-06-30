// UI metadata for the `project_type` enum (see ProjectType in
// shared/types/db.ts). Kept in one place so the create modal and the edit page
// render the same labels/descriptions. The type drives the "Verification
// Profile" injected into the agent system prompt.

import type { ProjectType } from '../../shared/types/db';

export interface ProjectTypeOption {
  value: ProjectType;
  label: string;
  description: string;
}

export const PROJECT_TYPE_OPTIONS: ProjectTypeOption[] = [
  {
    value: 'web',
    label: 'Web',
    description: 'UI web — vérification via dev server + Playwright (navigateur).',
  },
  {
    value: 'api',
    label: 'API / Backend',
    description: 'Service HTTP — vérification via curl/endpoints + état DB, sans navigateur.',
  },
  {
    value: 'cli',
    label: 'CLI',
    description: 'Outil en ligne de commande — vérification via la sortie et le code de retour.',
  },
  {
    value: 'library',
    label: 'Library',
    description: 'Bibliothèque — vérification via la suite de tests unitaires, sans serveur.',
  },
  {
    value: 'game',
    label: 'Game',
    description: 'Jeu — vérification via build + lancement et l’outillage du moteur.',
  },
];
