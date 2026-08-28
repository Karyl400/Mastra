import type { MetricSpec } from '../value-objects/metric';

export const SATISFACTION_METRICS: readonly MetricSpec[] = [
  {
    key: 'satisfaction.score',
    family: 'satisfaction',
    label: 'Note moyenne',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'no_mechanism',
      because:
        'Aucune question n’est jamais posée. Il n’existe ni pouce, ni note, ni formulaire — donc ' +
        'aucune table ne pourrait contenir une réponse. Afficher « 0 » ferait conclure que les ' +
        'gens sont mécontents, alors que personne ne leur a rien demandé : c’est la lecture ' +
        'PASSIVE d’un tableau de bord qui rend ce mensonge-là particulièrement coûteux.',
      wouldTake:
        'Deux boutons en fin d’échange — mais les boutons ont été retirés du chemin nominal le ' +
        '2026-08-19 (le `trigger_id` expire en 3 s sur une fonction froide, et à ≈ 19 ' +
        'messages/jour le cas froid EST le cas nominal). La forme viable est textuelle, comme ' +
        '« j’ai fini » : un dixième court-circuit à zéro token.',
    },
  },
  {
    key: 'satisfaction.responseRate',
    family: 'satisfaction',
    label: 'Taux de feedbacks reçus',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'no_mechanism',
      because: 'Corollaire du précédent : sans question posée, le dénominateur lui-même est vide.',
      wouldTake: 'Le mécanisme de `satisfaction.score`. Cette métrique en découle sans coût.',
    },
  },
  {
    key: 'satisfaction.sentiment',
    family: 'satisfaction',
    label: 'Analyse de sentiment',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'no_mechanism',
      because:
        'Aucun classifieur n’existe. Et la seule matière disponible est le contenu des DM : les ' +
        'faire passer par un modèle tiers pour les noter est une décision de confidentialité, ' +
        'pas une fonctionnalité de tableau de bord. Chaque passe consomme en outre un quota qui ' +
        'se compte à la JOURNÉE — le même que celui de l’assistant.',
      wouldTake:
        'Une décision explicite du propriétaire sur l’usage des DM, puis un classifieur ' +
        'déterministe (lexique) plutôt qu’un modèle — même arbitrage que la saillance des ' +
        'extraits, choisie en CODE pour ne pas coûter un aller-retour par consultation.',
    },
  },
];
