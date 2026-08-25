import { AGENT_TOOLS, agentHasTool } from '../../../../shared/agent-capabilities';

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

function asksForAScheduledReminder(lowerText: string): boolean {
  return REMINDER_ADDRESSEE.test(lowerText) && WHEN_MARKER.test(lowerText);
}

const APOS = "['’`´]";
const LB = '(?<![\\p{L}])';
const RB = '(?![\\p{L}])';

const REMINDER_ADDRESSEE = new RegExp(`${LB}rappelle[\\s-](?:moi|lui|nous|leur|les)${RB}`, 'iu');

const WHEN_WORDS = [
  'demain',
  'apres-demain',
  'après-demain',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
  'ce soir',
  'cet apres-midi',
  'cet après-midi',
  'la semaine prochaine',
  'le mois prochain',
] as const;

// eslint-disable-next-line security/detect-non-literal-regexp
const WHEN_MARKER = new RegExp(
  `${LB}(?:${WHEN_WORDS.join('|')}|dans \\d+|le \\d{1,2}|\\d{1,2}h|\\d{4}-\\d{2}-\\d{2})`,
  'iu',
);

const EXPERTISE_QUESTION_PATTERN = new RegExp(
  `${LB}qui\\s+(?:s${APOS}?\\s?occupe|g[eè]re|conna[iî]t|sait|ma[iî]trise|travaille|s${APOS}?y\\s+conna[iî]t)${RB}` +
    `|${LB}[aà]\\s+qui\\s+(?:je\\s+)?(?:m${APOS}?\\s?adresser|demandes?|demander|parler)${RB}`,
  'u',
);

const RECALL_QUESTION_PATTERN = new RegExp(
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

const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set(Object.keys(AGENT_TOOLS));

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

  if (asksForAScheduledReminder(lowerText)) return 'notificationAgent';

  for (const [agentId, keywords] of ESCAPE_INTENTS) {
    if (matchesAny(keywords)) return agentId;
  }

  const structural = CHANNEL_TOKEN_PATTERN.test(lowerText)
    ? TOPIC_BANDS.find((band) => band.pattern === CHANNEL_TOKEN_PATTERN)
    : undefined;

  const topic =
    structural ??
    TOPIC_BANDS.find(
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
