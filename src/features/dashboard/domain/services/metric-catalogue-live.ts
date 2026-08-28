import type { MetricSpec } from '../value-objects/metric';

export const LIVE_METRICS: readonly MetricSpec[] = [
  {
    key: 'live.activeUsers',
    family: 'live',
    label: 'Personnes actives maintenant',
    unit: 'count',
    source: {
      derived: true,
      from: ['conversation_turns (fenêtre 60 min)'],
      caveat:
        'La fenêtre est `CONVERSATION_TTL_MS` (60 min), le TTL unique qui gouverne déjà la ' +
        'mémoire et le routage collant. Choisir une autre durée ici ferait dire « actif » à ' +
        'quelqu’un dont le fil est déjà froid pour l’agent.',
    },
  },
  {
    key: 'live.openConversations',
    family: 'live',
    label: 'Conversations ouvertes',
    unit: 'count',
    source: { derived: true, from: ['conversation_turns.conversation_id (fenêtre 60 min)'] },
  },
  {
    key: 'live.feed',
    family: 'live',
    label: 'Tours affichés au flux',
    unit: 'count',
    source: {
      derived: true,
      from: ['conversation_turns'],
      caveat:
        'SANS BORNE DE TEMPS, à la différence de tous les compteurs de cette page : ce sont les ' +
        'derniers tours enregistrés, même vieux d’une semaine. Un flux de supervision vide est ' +
        'moins utile qu’un flux ancien daté. Le flux ne transporte AUCUN contenu de message — ' +
        'horodatage, rôle, agent, longueur, empreinte tronquée du fil. Le manager a le droit de ' +
        'lire les DM depuis le 2026-08-21 ; les faire défiler sur un écran de supervision est ' +
        'une autre chose, et ce n’est pas ce qui a été décidé.',
    },
  },
];
