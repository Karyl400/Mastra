import { agentHasTool } from '../../../../shared/agent-capabilities';

const ESCAPE_INTENTS: ReadonlyArray<readonly [agentId: string, keywords: readonly string[]]> = [
  ['recruitmentAgent', ['candidat', 'candidate', 'recrutement', 'entretien']],
  ['notificationAgent', ['notification', 'rappel']],
  ['knowledgeAgent', ['conversation', 'historique']],
  [
    'onboardingOrchestrator',
    [
      'crée',
      'créer',
      'création',
      'cree',
      'creer',
      'enregistre',
      'retrouve',
      'recherche',
      'identifiant',
    ],
  ],
];

const ORCHESTRATOR_TOPICS = [
  'document',
  'pdf',
  'docx',
  'guide',
  'guideline',
  'tâche',
  'tache',
  'onboarding',
] as const;

const NOTIFICATION_TOPICS = ['email', 'message'] as const;

const KNOWLEDGE_TOPICS = ['résume', 'résumé', 'resume', 'resumé'] as const;

// eslint-disable-next-line security/detect-unsafe-regex
const CHANNEL_TOKEN_PATTERN = /<#[CG][A-Z0-9]{2,}(?:\|[^>]*)?>/i;

const APOS = "['’`´]";
const LB = '(?<![\\p{L}])';
const RB = '(?![\\p{L}])';
const EXPERTISE_QUESTION_PATTERN = new RegExp(
  `${LB}qui\\s+(?:s${APOS}?\\s?occupe|g[eè]re|conna[iî]t|sait|ma[iî]trise|travaille|s${APOS}?y\\s+conna[iî]t)${RB}` +
    `|${LB}[aà]\\s+qui\\s+(?:je\\s+)?(?:m${APOS}?\\s?adresser|demandes?|demander|parler)${RB}`,
  'u',
);

/**
 * ⚠️ CETTE BANDE EST UNIQUEMENT INTERROGATIVE — aucun mot-clé nu.
 *
 * La première version portait `décidé|décision|convenu`, et un test de non-régression
 * PRÉEXISTANT l'a attrapée sur-le-champ : « je conteste cette décision » partait chez
 * `knowledgeAgent`. Même critère que celui qui avait fait écarter « ajoute » et « word » —
 * un mot très courant du français ne désigne pas une capacité. La FORME de la question, elle,
 * ne se prononce que pour demander ce qui s'est dit.
 */
const RECALL_QUESTION_PATTERN = new RegExp(
  // ⚠️ Le séparateur est `${APOS}?\\s*` et non `\\s+` : « qu'est-ce qu'ON a dit » n'a AUCUN
  // espace après « qu », et cette seule exigence faisait échouer la formulation la plus
  // courante des trois. Attrapé par un test, jamais à la lecture.
  `${LB}(?:qu${APOS}?est-ce\\s+qu|qu${APOS}?a-t-on|qu${APOS}?avons-nous|de\\s+quoi)${APOS}?\\s*` +
    `(?:\\S+\\s+){0,3}(?:d[ié]cid|convenu|dit|parl|discut)` +
    `|${LB}(?:ce\\s+)?qui\\s+(?:a|ont)\\s+[ée]t[ée]\\s+(?:d[ié]cid|convenu|dit|[ée]voqu)`,
  'u',
);

const TOPIC_BANDS: ReadonlyArray<{
  readonly agentId: string;
  readonly keywords: readonly string[];
  readonly pattern?: RegExp;
  readonly requiredTool: string;
  readonly overridesSticky: boolean;
}> = [
  {
    agentId: 'onboardingOrchestrator',
    keywords: ORCHESTRATOR_TOPICS,
    requiredTool: 'generateDocument',
    overridesSticky: true,
  },
  {
    agentId: 'notificationAgent',
    keywords: NOTIFICATION_TOPICS,
    requiredTool: 'sendNotification',
    overridesSticky: false,
  },
  {
    agentId: 'knowledgeAgent',
    keywords: KNOWLEDGE_TOPICS,
    requiredTool: 'getChannelHistory',
    pattern: CHANNEL_TOKEN_PATTERN,
    overridesSticky: true,
  },
  {
    agentId: 'knowledgeAgent',
    keywords: ['expert', 'spécialiste', 'specialiste', 'compétence', 'competence'],
    requiredTool: 'findExpertise',
    pattern: EXPERTISE_QUESTION_PATTERN,
    overridesSticky: true,
  },
  {
    agentId: 'knowledgeAgent',
    keywords: [],
    requiredTool: 'searchKnowledge',
    pattern: RECALL_QUESTION_PATTERN,
    // ⚠️ `true`, et il a fallu une mesure en production pour le trancher. Posé d'abord à
    // `false` par prudence, la bande n'a JAMAIS tiré : en DM la clé de conversation est le
    // canal, donc le palier collant verrouille tous les sujets pendant une heure — c'est l'état
    // absorbant corrigé le 2026-08-11, et il rendait la base inatteignable dans le seul cas qui
    // compte. Journal du 2026-08-20 : `agentId: onboardingOrchestrator, sticky: true`.
    //
    // La règle d'admission est respectée : `searchKnowledge` n'est porté que par UN agent, et
    // le délogement n'a lieu que si le fil en cours ne l'a pas. Le motif est purement
    // INTERROGATIF, donc il ouvre toujours une tâche neuve — c'est pour cela que
    // « on avait dit jeudi », qui peut CONTINUER une discussion d'agenda, en a été retiré.
    overridesSticky: true,
  },
];

const VERB_STEM_KEYWORDS: ReadonlySet<string> = new Set([
  'crée',
  'cree',
  'enregistre',
  'retrouve',
  'recherche',
]);

const VERB_SUFFIX_PATTERN = '(?:s|r|z|nt)?';

export const DEFAULT_AGENT_ID = 'onboardingOrchestrator';

const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set([
  'onboardingOrchestrator',
  'notificationAgent',
  'knowledgeAgent',
  'recruitmentAgent',
]);

export function matchesKeyword(lowerText: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = VERB_STEM_KEYWORDS.has(keyword) ? VERB_SUFFIX_PATTERN : 's?';
  // eslint-disable-next-line security/detect-non-literal-regexp
  const pattern = new RegExp(`(?<![\\p{L}])${escaped}${suffix}(?![\\p{L}])`, 'u');
  return pattern.test(lowerText);
}

export function routeToAgent(text: string, stickyAgentId?: string): string {
  const lowerText = (text ?? '').toLowerCase();
  const matchesAny = (keywords: readonly string[]): boolean =>
    keywords.some((keyword) => matchesKeyword(lowerText, keyword));

  for (const [agentId, keywords] of ESCAPE_INTENTS) {
    if (matchesAny(keywords)) return agentId;
  }

  const topic = TOPIC_BANDS.find(
    (band) => matchesAny(band.keywords) || (band.pattern?.test(lowerText) ?? false),
  );

  if (stickyAgentId && KNOWN_AGENT_IDS.has(stickyAgentId)) {
    const stickyCannotServe =
      topic !== undefined &&
      topic.overridesSticky &&
      !agentHasTool(stickyAgentId, topic.requiredTool);
    if (!stickyCannotServe) return stickyAgentId;
  }

  if (topic) return topic.agentId;

  return DEFAULT_AGENT_ID;
}
