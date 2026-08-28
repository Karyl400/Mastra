import type { MetricSpec } from '../value-objects/metric';

export const AI_METRICS: readonly MetricSpec[] = [
  {
    key: 'ai.zeroTokenShare',
    family: 'ai',
    label: 'Part des réponses sans modèle',
    unit: 'percent',
    source: {
      derived: true,
      from: ['conversation_turns', "audit_logs (action='SLACK_MESSAGE')"],
      caveat:
        'ESTIMATION, et sa formule doit être lue. `SLACK_MESSAGE` n’est journalisé qu’APRÈS les ' +
        'court-circuits ; la différence avec les tours `user` approxime les réponses à zéro ' +
        'token. ⚠️ Les deux compteurs n’ont PAS la même durée de vie : `conversation_turns` est ' +
        'effaçable par la personne (« oublie ce que je t’ai dit »), `audit_logs` non. Quand le ' +
        'second dépasse le premier, la soustraction n’a plus de sens et la métrique se déclare ' +
        'incomparable — afficher 0 % se lirait comme « aucune réponse gratuite », l’inverse de ' +
        'la vérité.',
    },
  },
  {
    key: 'ai.modelHandled',
    family: 'ai',
    label: 'Messages passés par un modèle (24 h)',
    unit: 'count',
    source: { derived: true, from: ["audit_logs (action='SLACK_MESSAGE')"] },
  },
  {
    key: 'ai.humanHandover',
    family: 'ai',
    label: 'Réponses auto vs intervention humaine',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'no_mechanism',
      because:
        'Il n’existe aucune intervention humaine dans ce produit : ni reprise en main, ni file ' +
        'd’attente d’opérateur, ni passation. Le chiffre honnête serait 100 % automatique — mais ' +
        'ce serait une TAUTOLOGIE affichée comme une performance, exactement le genre de chiffre ' +
        'flatteur que ce dépôt refuse.',
      wouldTake:
        'Un mécanisme de reprise en main : une file, une notification au manager, un moyen de ' +
        'répondre à la place de l’agent. Rien de tel n’est câblé.',
    },
  },
  {
    key: 'ai.escalationRate',
    family: 'ai',
    label: 'Taux de résolution sans escalade',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'no_mechanism',
      because:
        'L’« escalade » de ce produit est une PHRASE : les textes renvoient vers Nazer, le ' +
        'General Manager (`ESCALATION_CONTACT`). Personne n’est notifié, aucun ticket n’est ' +
        'ouvert, rien ne dit si la personne s’est effectivement tournée vers lui. Compter les ' +
        'réponses contenant son nom mesurerait la fréquence d’une formule, pas une escalade.',
      wouldTake:
        'Que l’escalade soit un ACTE — une notification au manager, avec son issue — et non ' +
        'une phrase.',
    },
  },
  {
    key: 'ai.unsupportedClaims',
    family: 'ai',
    label: 'Réponses requalifiées (FAIT / NARRATION)',
    unit: 'count',
    source: {
      derived: true,
      from: ["audit_logs (action='AGENT_RUN')"],
      caveat:
        'Comptable depuis le 2026-08-25. Le verdict partait auparavant dans les logs Vercel, ' +
        'remis à zéro à chaque redéploiement : le seul détecteur d’incohérence du produit était ' +
        'INCOMPTABLE. Un compte non nul n’est pas une panne — c’est le garde-fou qui travaille.',
    },
  },
  {
    key: 'ai.runFailures',
    family: 'ai',
    label: 'Runs en échec (24 h)',
    unit: 'count',
    source: {
      derived: true,
      from: ["audit_logs (action='AGENT_RUN', status='failure')"],
      caveat:
        'Réunit le run qui a levé, celui dont l’agent n’a pas pu être résolu, et celui dont la ' +
        'réponse a été requalifiée. ⚠️ N’inclut PAS les entrées refusées par le garde-fou ' +
        'anti-injection : compter un refus réussi comme une panne était le défaut relevé en ' +
        'production le 2026-08-25, quatre injections bloquées en 0 à 2 ms s’affichant comme ' +
        'quatre échecs.',
    },
  },
  {
    key: 'ai.injectionsBlocked',
    family: 'ai',
    label: 'Injections bloquées (24 h)',
    unit: 'count',
    source: {
      derived: true,
      from: ["audit_logs (action='AGENT_RUN', status='denied')"],
      caveat:
        'Le refus tombe AVANT tout appel de modèle — 0 à 2 ms mesurées en production — donc ' +
        'une injection ne coûte rien. Un compte non nul n’est pas une alerte : c’est le ' +
        'garde-fou qui travaille.',
    },
  },
  {
    key: 'ai.toolCalls',
    family: 'ai',
    label: 'Appels d’outils (24 h)',
    unit: 'count',
    source: {
      derived: true,
      from: ["audit_logs (action='AGENT_RUN')"],
      caveat:
        'Le détail par outil est affiché sous la carte. C’était la dette n° 1 de ' +
        '`docs/tool-design-audit.md` : un dépôt qui décide sur mesure ne mesurait pas ses ' +
        'propres outils.',
    },
  },
  {
    key: 'ai.latency',
    family: 'ai',
    label: 'Temps de réponse médian de l’IA',
    unit: 'ms',
    source: {
      derived: true,
      from: ["audit_logs (action='AGENT_RUN')"],
      caveat:
        'Médiane et non moyenne : un seul run tombé sur le repli Mistral (11,7 s mesurées) ' +
        'déplace une moyenne de plusieurs secondes. Au-delà d’une dizaine de secondes, la ' +
        'lenteur devient une mauvaise impression — c’est ce seuil qu’on surveille.',
    },
  },
];
