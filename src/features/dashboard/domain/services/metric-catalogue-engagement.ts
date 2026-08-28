import type { MetricSpec } from '../value-objects/metric';

export const ENGAGEMENT_METRICS: readonly MetricSpec[] = [
  {
    key: 'engagement.messages',
    family: 'engagement',
    label: 'Messages reçus (24 h)',
    unit: 'count',
    source: { derived: true, from: ["conversation_turns (role='user')"] },
  },
  {
    key: 'engagement.perUser',
    family: 'engagement',
    label: 'Messages par personne (24 h)',
    unit: 'count',
    source: { derived: true, from: ['conversation_turns.slack_user_id'] },
  },
  {
    key: 'engagement.replyRate',
    family: 'engagement',
    label: 'Taux de réponse aux relances',
    unit: 'percent',
    source: {
      derived: true,
      from: ['conversation_turns'],
      caveat:
        'Un tour `assistant` est « répondu » si un tour `user` le suit dans la même conversation. ' +
        'C’est une mesure de CONTINUATION, pas d’intention : une personne qui obtient sa réponse ' +
        'du premier coup et s’arrête compte comme n’ayant pas répondu. Lire les deux ensemble.',
    },
  },
  {
    key: 'engagement.replyDelay',
    family: 'engagement',
    label: 'Délai médian de réponse humaine',
    unit: 'minutes',
    source: {
      derived: true,
      from: ['conversation_turns.created_at'],
      caveat:
        'Médiane et non moyenne : un fil repris le lendemain déplace une moyenne de plusieurs ' +
        'heures et rend le chiffre illisible.',
    },
  },
  {
    key: 'engagement.profileActivation',
    family: 'engagement',
    label: 'Activation — dossier complété',
    unit: 'percent',
    source: { derived: true, from: ['employees', 'slack_directory'] },
  },
  {
    key: 'engagement.channelActivation',
    family: 'engagement',
    label: 'Activation — canaux rejoints',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'not_persisted',
      because:
        'Les invitations aux canaux partent réellement à la soumission de l’entretien, et la ' +
        'réponse nomme le résultat canal par canal — mais ce résultat n’est écrit nulle part. ' +
        'Les tables `slack_channels` / `slack_channel_members` sont un inventaire ponctuel : ni ' +
        '`member_joined_channel` ni `member_left_channel` ne sont abonnés, donc rien ne vient ' +
        'jamais les démentir.',
      wouldTake:
        'Écrire l’issue par canal (rejoint / déjà membre / échoué) au moment de l’invitation — ' +
        'la donnée existe déjà à cet instant, elle est seulement jetée.',
    },
  },
  {
    key: 'engagement.documentOpened',
    family: 'engagement',
    label: 'Activation — document consulté',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'no_mechanism',
      because:
        'La colonne `documents.viewed_at` existe et n’est écrite par AUCUN chemin. Ce n’est pas ' +
        'un oubli : il n’existe aucune URL de téléchargement dans ce système, le fichier est ' +
        'livré par upload dans le fil Slack. Rien, côté produit, ne peut observer une ouverture.',
      wouldTake:
        'Servir les documents derrière une route du produit plutôt que par upload — ce qui ' +
        'échangerait une livraison qui marche contre une mesure, et rouvrirait la porte du faux ' +
        'lien inventé en production le 2026-08-11.',
    },
  },
];
