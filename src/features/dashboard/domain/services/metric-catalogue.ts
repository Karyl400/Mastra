import { METRIC_FAMILIES, type MetricSpec } from '../value-objects/metric';

export { METRIC_FAMILIES };
export type { MetricSpec };

const CATALOGUE: readonly MetricSpec[] = [
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
        'token. Elle est imprécise dans les deux sens : certains court-circuits n’écrivent aucun ' +
        'tour, et tous les tours écrits ne viennent pas d’un message entrant.',
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

  {
    key: 'health.notificationFailure',
    family: 'health',
    label: 'Taux d’échec d’envoi',
    unit: 'percent',
    source: {
      derived: true,
      from: ["notifications.status='failed'"],
      caveat:
        'Couvre les emails et rappels, pas la publication d’un message Slack : un ' +
        '`chat.postMessage` en `not_in_channel` échoue SILENCIEUSEMENT pour l’utilisateur — le ' +
        'message d’erreur de repli est posté dans le même canal inaccessible, donc échoue aussi.',
    },
  },
  {
    key: 'health.documentDelivery',
    family: 'health',
    label: 'Documents réellement livrés',
    unit: 'percent',
    source: {
      derived: true,
      from: ["documents.status='sent'"],
      caveat:
        'Le document est TOUJOURS enregistré, même quand la livraison échoue ; seule une ' +
        'livraison réussie pose `sent`. L’écart entre les deux EST la mesure.',
    },
  },
  {
    key: 'health.errors',
    family: 'health',
    label: 'Refus et erreurs (24 h)',
    unit: 'count',
    source: {
      derived: true,
      from: ["audit_logs (status='failure' | 'denied')"],
      caveat:
        'Ne couvre que ce que le handler journalise — `RATE_LIMITED`, `AUTHZ_DENIED`, ' +
        '`SLACK_MESSAGE`. Une exception levée dans un outil n’apparaît pas ici.',
    },
  },
  {
    key: 'health.rateLimited',
    family: 'health',
    label: 'Messages refusés au quota (24 h)',
    unit: 'count',
    source: { derived: true, from: ["audit_logs (action='RATE_LIMITED')"] },
  },
  {
    key: 'health.uptime',
    family: 'health',
    label: 'Disponibilité',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'external_owner',
      because:
        'Une fonction serverless ne peut pas mesurer sa propre disponibilité : quand elle est ' +
        'indisponible, elle ne tourne pas, donc elle n’écrit rien. Un « 100 % » calculé depuis ' +
        'l’intérieur ne dit qu’une chose — que le calcul a pu tourner.',
      wouldTake:
        'Une sonde EXTÉRIEURE (Vercel Observability, ou un ping externe). La mesure appartient ' +
        'à la plateforme, pas au produit ; l’afficher ici la fabriquerait.',
    },
  },

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

export const METRIC_CATALOGUE = CATALOGUE;

export function derivableMetrics(): readonly MetricSpec[] {
  return CATALOGUE.filter((m) => m.source.derived);
}

export function missingMetrics(): readonly MetricSpec[] {
  return CATALOGUE.filter((m) => !m.source.derived);
}

export function metricsOf(family: string): readonly MetricSpec[] {
  return CATALOGUE.filter((m) => m.family === family);
}
