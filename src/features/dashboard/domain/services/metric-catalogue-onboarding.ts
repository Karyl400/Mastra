import type { MetricSpec } from '../value-objects/metric';

export const ONBOARDING_METRICS: readonly MetricSpec[] = [
  {
    key: 'onboarding.people',
    family: 'onboarding',
    label: 'Personnes du workspace',
    unit: 'count',
    source: { derived: true, from: ['slack_directory'] },
  },
  {
    key: 'onboarding.linked',
    family: 'onboarding',
    label: 'Rattachées à un dossier',
    unit: 'count',
    source: {
      derived: true,
      from: ['slack_directory.employee_id'],
      caveat:
        'Cette colonne n’était écrite par aucun chemin de production avant le 2026-08-19 : les ' +
        'personnes arrivées avant cette date peuvent avoir un dossier sans être rattachées.',
    },
  },
  {
    key: 'onboarding.records',
    family: 'onboarding',
    label: 'Dossiers créés',
    unit: 'count',
    source: { derived: true, from: ['employees (deleted_at IS NULL)'] },
  },
  {
    key: 'onboarding.completed',
    family: 'onboarding',
    label: 'Parcours terminés',
    unit: 'count',
    source: { derived: true, from: ['onboarding_progress.completed_at'] },
  },
  {
    key: 'onboarding.interviews',
    family: 'onboarding',
    label: 'Entretiens renseignés',
    unit: 'count',
    source: { derived: true, from: ['onboarding_interview'] },
  },
  {
    key: 'onboarding.completionRate',
    family: 'onboarding',
    label: 'Taux de complétion global',
    unit: 'percent',
    source: {
      derived: true,
      from: ['onboarding_progress'],
      caveat:
        'Rapporté au nombre de PERSONNES du workspace, pas au nombre de dossiers : rapporté aux ' +
        'dossiers, il vaudrait presque toujours 100 % — un dossier n’est créé qu’en complétant ' +
        'le parcours. Le dénominateur honnête est le monde réel, pas la table.',
    },
  },
  {
    key: 'onboarding.timeToComplete',
    family: 'onboarding',
    label: 'Temps moyen de complétion',
    unit: 'minutes',
    source: {
      derived: true,
      from: ['onboarding_progress.started_at → completed_at'],
      caveat:
        'Sur le chemin conversationnel, `started_at` est posé au moment de la création du ' +
        'dossier, qui suit les questions. La durée mesurée est donc un MINORANT du temps vécu.',
    },
  },
  {
    key: 'onboarding.funnel',
    family: 'onboarding',
    label: 'Entonnoir d’arrivée',
    unit: 'count',
    source: {
      derived: true,
      from: ['slack_directory', 'employees', 'onboarding_progress', 'onboarding_interview'],
      caveat:
        'L’entonnoir demandé — « par étape d’onboarding » — n’existe PAS : le suivi de tâches a ' +
        'été supprimé le 2026-08-14 et `onboarding_progress.total_steps` vaut 1. Ce qu’on montre ' +
        'est l’entonnoir RÉEL du produit : présent → rattaché → dossier → parcours terminé → ' +
        'entretien rempli. Il révèle les mêmes goulots, il ne prétend pas être l’autre.',
    },
  },
];
