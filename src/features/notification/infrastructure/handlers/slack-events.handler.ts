import { WebClient } from '@slack/web-api';
import { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import { logger } from '../../../../shared/logger';
import { wrapAgentInput } from '../../../../shared/security/llm-guardrail';
import { sanitizeAgentOutput } from '../../../../shared/security/agent-output';
import { SlackAdapter, type SlackBlock } from '../providers/slack.adapter';
import { SlackWorkspaceService } from '../providers/slack-workspace.service';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { encodePrefill, type ProfileModalPrefill } from './profile-modal';
import { deriveConversationId } from '../../../conversation/domain/value-objects/conversation-id';
import {
  selectWindow,
  CONVERSATION_TOKEN_BUDGET,
} from '../../../conversation/domain/services/token-window';
import {
  CONVERSATION_TTL_MS,
  type ConversationRepository,
} from '../../../conversation/domain/ports/conversation.repository';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { DrizzleConversationRepository } from '../../../conversation/infrastructure/repositories/drizzle-conversation.repository';
import { startProgress } from '../providers/slack-progress';
import {
  SLACK_EVENT_DEDUP_RETENTION_MS,
  type SlackEventDedupRepository,
} from '../../domain/ports/slack-event-dedup.repository';
import { DrizzleSlackEventDedupRepository } from '../repositories/drizzle-slack-event-dedup.repository';
import { buildSlackRequestContext } from '../../../../shared/slack-request-context';

/**
 * Handler des événements Slack (Events API).
 *
 * Le découpage est volontaire :
 *  - `accept()` tourne AVANT l'ACK HTTP (< 3 s imposées par Slack) : filtrage de type, garde
 *    anti-boucle bon marché et déduplication. Il est ASYNCHRONE depuis le 2026-08-11 — la
 *    prise de clé fait un aller-retour vers la base partagée. C'est le prix à payer : un
 *    rejeu Slack routé vers une AUTRE instance ne peut être écarté que là, et seulement
 *    avant tout traitement.
 *  - `handleEvent()` est ASYNCHRONE et lancé en tâche de fond APRÈS l'ACK : il résout
 *    le `bot_user_id`, appelle l'agent LLM (2 à 17 s d'après TEST_REPORT.md) puis poste
 *    la réponse dans Slack.
 */

/**
 * Événement porteur de texte : `message` et `app_mention`.
 *
 * `type` reste un `string` ouvert : le fil Slack est du JSON non fiable, et une
 * union fermée affirmerait une garantie qu'on n'a pas. Le filtrage réel est
 * fait par `SUPPORTED_EVENT_TYPES`, à l'exécution.
 */
export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  app_id?: string;
  bot_profile?: unknown;
}

/** Profil porté par le payload `team_join`. Tous les champs sont optionnels. */
export interface SlackTeamJoinUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_workflow_bot?: boolean;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  profile?: {
    email?: string;
    first_name?: string;
    last_name?: string;
    real_name?: string;
  };
}

/**
 * Arrivée d'une personne dans le workspace.
 *
 * Contrairement à un message, `user` est un OBJET complet, et l'événement ne
 * porte ni `channel`, ni `ts`, ni `text` — d'où l'union ci-dessous plutôt qu'une
 * interface unique où `user` serait `string | objet`.
 */
export interface SlackTeamJoinEvent {
  type: 'team_join';
  user?: SlackTeamJoinUser;
  event_ts?: string;
}

export type SlackEvent = SlackTeamJoinEvent | SlackMessageEvent;

/**
 * Prédicat de restriction. Une comparaison `event.type === 'team_join'` ne
 * suffit pas à restreindre l'union : le membre « message » déclare `type` en
 * `string` ouvert, donc il resterait dans la branche vraie.
 */
export function isTeamJoinEvent(event: SlackEvent): event is SlackTeamJoinEvent {
  return event.type === 'team_join';
}

export interface SlackEventEnvelope {
  type?: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}

export type SlackEventDecision =
  { action: 'process'; event: SlackEvent } | { action: 'ignore'; reason: SlackIgnoreReason };

/**
 * Motifs de rejet. Chacun est journalisé tel quel par la route
 * (`slack-events.route.ts`) : ne jamais recycler un motif existant pour un
 * nouveau cas, le log de production mentirait.
 */
export type SlackIgnoreReason =
  | 'not_event_callback'
  | 'no_event'
  | 'unsupported_event_type'
  | 'not_a_dm'
  | 'bot_message'
  | 'duplicate'
  | 'empty_text'
  | 'wrong_team'
  | 'no_user'
  | 'bot_join'
  | 'deleted_user'
  | 'restricted_user'
  | 'duplicate_mention';

export interface SlackAcceptContext {
  /** En-tête `X-Slack-Retry-Num` (présent uniquement sur les renvois Slack). */
  retryNum?: string | null;
}

export interface SlackEventsHandlerOptions {
  /** Injection d'un WebClient (tests unitaires). */
  slackClient?: WebClient;
  /**
   * Émetteur des messages à blocs (DM de bienvenue).
   *
   * Injecté par options plutôt que repris de `src/mastra/index.ts` : ce module
   * importe déjà la route qui construit ce handler, donc la dépendance inverse
   * créerait un cycle d'import — panne d'initialisation classique en ESM bundlé.
   */
  chatProvider?: Pick<SlackAdapter, 'sendBlocks'>;
  /** Annuaire Slack, pour le repli quand `team_join` ne porte pas l'email. */
  workspaceProvider?: Pick<SlackWorkspaceProvider, 'getUserById'>;
  /** Taille max du cache de déduplication. */
  dedupMax?: number;
  /** TTL du cache de déduplication, en ms. */
  dedupTtlMs?: number;
  /**
   * Durée au-delà de laquelle une entrée `in-flight` est considérée abandonnée
   * (fonction serverless gelée / tuée) et l'événement redevient rejouable.
   */
  inFlightGraceMs?: number;
  /**
   * Mémoire conversationnelle. Injectée pour les tests (doublure in-memory) ; en
   * production le dépôt Drizzle est construit paresseusement, au premier message.
   *
   * `null` DÉSACTIVE explicitement la mémoire — utile pour isoler un test du reste
   * du comportement sans avoir à fournir une doublure.
   */
  conversationRepository?: ConversationRepository | null;
  /**
   * Déduplication PARTAGÉE entre instances. Injectée pour les tests (une seule doublure
   * partagée par deux handlers simule deux instances serverless devant le même store) ;
   * en production le dépôt Drizzle est construit paresseusement.
   *
   * `null` la DÉSACTIVE et ramène au seul cache local — l'ancien comportement, celui qui
   * laissait passer les doubles réponses.
   */
  dedupRepository?: SlackEventDedupRepository | null;
  /** Budget de contexte alloué à l'historique, en tokens. */
  conversationTokenBudget?: number;
  /** Durée d'inactivité au-delà de laquelle le fil est clos (mémoire ET collance). */
  conversationTtlMs?: number;
}

/**
 * État d'un événement dans le cache de déduplication.
 *  - `in-flight` : `accept()` l'a laissé passer, `handleEvent()` n'a pas encore rendu la main.
 *  - `done`      : `handleEvent()` est allé au bout — le rejeu doit être ignoré définitivement.
 */
type DedupStatus = 'in-flight' | 'done';

interface DedupEntry {
  status: DedupStatus;
  /** `Date.now()` au moment où le statut courant a été posé. */
  startedAt: number;
}

/**
 * Une invocation ne peut pas dépasser le `maxDuration` de la fonction Vercel
 * (60 s, cf. `scripts/fix-vercel-output.js`). Passé ce délai, une entrée encore
 * `in-flight` ne peut plus correspondre à un traitement vivant.
 */
const DEFAULT_IN_FLIGHT_GRACE_MS = 60_000;

/** Types d'événements Slack que le bot traite. Tout le reste est ignoré. */
const SUPPORTED_EVENT_TYPES = new Set(['app_mention', 'message', 'team_join']);

/** Identifiant fixe de Slackbot : il « rejoint » techniquement chaque workspace. */
const SLACKBOT_USER_ID = 'USLACKBOT';

/** `action_id` du bouton du DM de bienvenue, lu par la route d'interactivité. */
export const COMPLETE_PROFILE_ACTION_ID = 'complete_profile';

/**
 * Aiguillage mot-clé → agent, en TROIS BANDES. Ces listes sont CONTRACTUELLES : elles sont
 * documentées dans CLAUDE.md, ne pas les modifier sans mettre la doc à jour.
 *
 * ## Pourquoi trois bandes et non deux paliers
 *
 * Le découpage précédent — « intentions de l'orchestrateur » PRIORITAIRES, puis palier
 * collant, puis thématiques — faisait de `onboardingOrchestrator` un ÉTAT ABSORBANT, mesuré
 * sur la campagne du 2026-08-11 :
 *  - `stickyAgentId` est renseigné dès le premier tour, donc les paliers thématiques étaient
 *    MORTS à partir du message 2. En DM la clé de conversation est le canal : tous les sujets
 *    d'une heure partageaient ce verrou, et `notificationAgent` n'a JAMAIS été atteignable en
 *    série A ;
 *  - le seul palier capable de déplacer un fil ne menait QU'À l'orchestrateur, sans retour.
 *    B6 (« ajoute ») et C7 (« guide » / « pdf ») ont ainsi ARRACHÉ leur fil vers un agent qui
 *    a hérité de la mémoire d'un autre et promis des capacités qu'il n'a pas — les deux
 *    réponses les plus fausses de la campagne.
 *
 * D'où la forme retenue : **le palier d'échappement devient SYMÉTRIQUE**. Chaque agent y a
 * ses propres termes, donc aucun n'est un puits ; et les termes qui détournaient les réponses
 * de suivi redescendent SOUS le palier collant.
 */

/**
 * BANDE 1 — ÉCHAPPEMENT. Évaluée AVANT le fil en cours.
 *
 * Critère d'admission, plus strict que « désigne cet agent » : le terme doit ouvrir une
 * TÂCHE NOUVELLE, pas continuer celle en cours. C'est la porte de sortie d'un fil collé sur
 * le mauvais agent — sans elle, une conversation mal aiguillée serait un piège sans issue,
 * et c'est l'acquis du 2026-08-10 (« retrouve l'employé dont l'email est X » partait chez
 * `notificationAgent`, qui n'a pas `findEmployeeByEmail` : la recherche par email était
 * structurellement inatteignable).
 *
 * L'ordre du tableau EST la priorité entre bandes-1 concurrentes : « envoie un email avec le
 * questionnaire » va au moteur de questionnaire, comportement conservé.
 *
 * Volontairement ABSENTS :
 *  - « ajoute » — verbe français générique. C'est lui qui a détourné B6 (« ajoute une
 *    question à choix multiple ») vers un agent sans aucun tool de questionnaire. Même
 *    critère que celui qui a fait écarter « word » ;
 *  - « profil », « statut », « intégration » — trop courants, ils captureraient « planifie un
 *    rappel : compléter son profil » ou « génère un questionnaire d'intégration » ;
 *  - « génère » — il sert aussi bien `generateDocument` que `generateQuestionnaire`.
 */
const ESCAPE_INTENTS: ReadonlyArray<readonly [agentId: string, keywords: readonly string[]]> = [
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
  ['questionnaireEngine', ['questionnaire', 'évaluation', 'quiz']],
  ['notificationAgent', ['notification', 'rappel']],
];

/**
 * BANDE 3 — THÉMATIQUE. Évaluée APRÈS le fil en cours, donc seulement quand aucun agent ne
 * mène la conversation (fil neuf, ou clos par le TTL de 60 min).
 *
 * On y trouve les termes qui désignent bien un agent mais qui, dans un fil vivant, sont
 * presque toujours des RÉPONSES DE SUIVI : « Donne le PDF alors », « envoie-le en docx »,
 * « et par email ? ». Les faire primer sur le fil est exactement ce qui a produit
 * l'alternance A → B → A → B → A entre deux agents amnésiques.
 *
 * `guideline` est listé à part car le bord droit du motif empêche `guide` de matcher à
 * l'intérieur du mot. « word » reste écarté : mot anglais courant (« in other words »).
 */
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

const QUESTIONNAIRE_TOPICS = ['test'] as const;

const NOTIFICATION_TOPICS = ['email', 'message'] as const;

/**
 * Mots-clés qui sont des RADICAUX VERBAUX, et tolèrent donc les désinences françaises.
 *
 * Régression corrigée le 2026-08-11 : le bord droit `s?(?![\p{L}])` cassait tous les
 * infinitifs. « Tu peux **retrouver** l'employé dont l'email est X » ne matchait plus la
 * bande 1 et retombait sur `NOTIFICATION_TOPICS` — précisément le bug que cette bande avait
 * été créée pour supprimer, revenu par la conjugaison.
 *
 * La tolérance est déclarée PAR MOT et non globale, et c'est la clé de la correction : les
 * mots-clés NOMINAUX (`rappel`, `message`, `test`) gardent le seul pluriel. L'ouvrir à tous
 * ferait revenir les faux positifs d'origine — « rappelle », « messagerie », « testez ».
 */
const VERB_STEM_KEYWORDS: ReadonlySet<string> = new Set([
  'crée',
  'cree',
  'enregistre',
  'retrouve',
  'recherche',
]);

/** Désinences tolérées sur un radical verbal : pluriel, infinitif, 2ᵉ et 3ᵉ personnes. */
const VERB_SUFFIX_PATTERN = '(?:s|r|z|nt)?';

/**
 * Identifiants d'agents connus. Sert à valider l'agent collant relu en base : une valeur
 * corrompue ou l'identifiant d'un agent retiré du registre ferait sinon lever
 * `mastra.getAgent()` à chaque message du fil, condamnant la conversation entière.
 */
const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set([
  'onboardingOrchestrator',
  'questionnaireEngine',
  'notificationAgent',
]);

/**
 * Garde-fou de REQUÊTE : nombre de tours chargés avant fenêtrage. Ce n'est pas le plafond
 * de contexte — celui-là se compte en tokens (`selectWindow`). Il évite seulement de tirer
 * un fil de mille messages en mémoire pour n'en garder que six.
 */
const CONVERSATION_QUERY_LIMIT = 40;

/**
 * Une purge est lancée tous les N messages traités, en tâche de fond. Pas de cron : le
 * projet n'en a aucun, et la rétention n'a pas besoin d'être ponctuelle.
 */
const PRUNE_EVERY_N_MESSAGES = 100;

/**
 * Extrait le contenu ASSAINI d'une entrée encadrée par `wrapAgentInput`.
 *
 * Format produit par le garde-fou :
 *   `<PREFIX_user_input>\n{assaini}\n</PREFIX_user_input>`
 *
 * On ne réimplémente surtout pas l'assainissement : on récupère le résultat de celui que le
 * garde-fou vient d'appliquer. C'est ce texte-là, et lui seul, qui a le droit d'entrer en
 * mémoire — le texte brut y ferait persister un faux délimiteur, rejoué ensuite à chaque tour.
 *
 * Le repli sur `fallback` ne sert qu'au cas où le format changerait ; il est signalé par
 * l'appelant, jamais silencieux.
 */
export function unwrapSanitizedInput(wrapped: string, fallback: string): string {
  const firstNewline = wrapped.indexOf('\n');
  const lastNewline = wrapped.lastIndexOf('\n');
  if (firstNewline < 0 || lastNewline <= firstNewline) return fallback;
  return wrapped.slice(firstNewline + 1, lastNewline);
}

/* ----------------------------------------------------------------------- *
 * Préambule serveur : QUI parle au modèle
 * ----------------------------------------------------------------------- */

/**
 * Préfixe posé sur un tour `assistant` produit par un AUTRE agent que celui du tour courant.
 *
 * `loadHistory` ne filtre pas par `agentId` — et c'est délibéré, voir `buildMessages` : les
 * faits énoncés dans le fil (un email, un UUID) restent utiles quel que soit l'agent qui les
 * a recueillis. Ce qui ne l'est pas, c'est de LIRE LA VOIX D'UN AUTRE COMME LA SIENNE : en
 * C7, l'orchestrateur a repris le motif de `notificationAgent` (redemander sujet, texte,
 * canal) parce que rien ne distinguait ces tours des siens.
 */
export const FOREIGN_TURN_PREFIX = '[autre agent] ';

/**
 * Caractères conservés dans un nom d'affichage Slack.
 *
 * ⚠️ Le nom d'affichage est une donnée CONTRÔLÉE PAR SON PORTEUR. Injecté brut dans un
 * message `system`, il devient un vecteur d'injection de prompt de premier ordre — bien plus
 * direct que le texte du message, qui passe lui par `wrapAgentInput`. On ne garde donc que
 * des lettres, marques, chiffres et la ponctuation d'un patronyme ; tout le reste, retours à
 * la ligne et chevrons compris, devient une espace.
 */
const DISPLAY_NAME_ALLOWED = /[^\p{L}\p{M}\p{N} .'’-]+/gu;

/** Un patronyme plus long est tronqué : c'est un budget de tokens, pas un champ libre. */
const DISPLAY_NAME_MAX_CHARS = 48;

export function sanitizeDisplayName(raw: string | undefined | null): string {
  return (raw ?? '')
    .normalize('NFKC')
    .replace(DISPLAY_NAME_ALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DISPLAY_NAME_MAX_CHARS)
    .trim();
}

/**
 * Message SERVEUR placé avant l'historique et avant le bloc balisé du message courant.
 *
 * ## Pourquoi il existe
 *
 * `cleanText` supprimait toutes les mentions et `slackUserId` ne voyageait que par le
 * `requestContext`, qui n'entre PAS dans la fenêtre du modèle. Le seul humain nommé dans tout
 * le contexte était donc le SUJET de la requête — et comme le bloc de style impose le
 * tutoiement, « tu » ne pouvait se résoudre que sur lui. D'où « **Ton** profil », « **Tu** as
 * 5 tâches » quand un manager interroge un tiers. Le cas fréquent (on demande son propre
 * profil) le rendait invisible.
 *
 * ## Pourquoi PAS dans le bloc `<kisso_XXXX_user_input>`
 *
 * La DIRECTIVE 3.1 déclare le contenu de ce bloc NON FIABLE. Y glisser une affirmation du
 * serveur reviendrait à la dévaluer nous-mêmes, et un seul bloc ouvrant est autorisé par
 * appel (`validateDelimiterIntegrity`). Un message `system` distinct est le seul canal qui
 * soit à la fois dans la fenêtre du modèle et hors de la zone déclarée hostile.
 *
 * ## Coût
 *
 * ≈ 35 tokens par tour, ≈ 69 avec l'avertissement d'attribution (mesuré, verrouillé par
 * test). Contrainte : Groq plafonne à 100 000 tokens/JOUR, soit ≈ 19 messages.
 */
export function buildContextPreamble(input: {
  slackUserId?: string | null;
  displayName?: string;
  hasForeignTurns?: boolean;
}): string {
  const lines: string[] = [];

  if (input.slackUserId) {
    const name = sanitizeDisplayName(input.displayName);
    const who = name ? `${name} (<@${input.slackUserId}>)` : `<@${input.slackUserId}>`;
    lines.push(
      `Interlocuteur : ${who}. « tu » désigne cette personne, et elle seule ; toute autre personne nommée est un tiers.`,
    );
  }

  if (input.hasForeignTurns) {
    lines.push(
      `Les tours préfixés « ${FOREIGN_TURN_PREFIX.trim()} » viennent d'un autre assistant : ne t'attribue ni leurs actions ni leurs capacités.`,
    );
  }

  return lines.join('\n');
}

/* ----------------------------------------------------------------------- *
 * Réconciliation FAIT / NARRATION
 * ----------------------------------------------------------------------- */

/**
 * Verbes d'accompli, sans accent (le texte est normalisé avant comparaison).
 * Liste FERMÉE : on cherche une CONTRADICTION, jamais une invraisemblance.
 */
const DONE_VERBS =
  '(?:envoye|cree|genere|enregistre|programme|planifie|transmis|transmise|ajoute|publie|telecharge)';

/**
 * Formules affirmant qu'une action A EU LIEU.
 *
 * Le critère d'admission est strict : la formule doit être FAUSSE PAR CONSTRUCTION si aucun
 * outil n'a tourné. « Je peux t'envoyer… », « Veux-tu que je t'envoie… », « Il faudra
 * créer… » n'en sont pas — ce sont des propositions, et les inclure transformerait chaque
 * tour de conversation ordinaire en accusation.
 *
 * Formules relevées telles quelles sur la campagne du 2026-08-11 : « C'est fait ! »,
 * « Ton Guide en PDF est prêt », « t'a été envoyé ».
 */
const ACCOMPLISHMENT_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "c'est fait", pattern: /\bc'est (?:fait|bon|parti|envoye)\b/ },
  {
    label: 'première personne',
    pattern: new RegExp(
      `\\b(?:j'ai|je t'ai|je l'ai|je lui ai|je vous ai|je les ai) (?:bien |deja )?${DONE_VERBS}e?s?\\b`,
    ),
  },
  {
    label: 'je viens de',
    pattern:
      /\bje viens (?:de |d')(?:t'|l'|lui |vous |les )?(?:envoyer|creer|generer|enregistrer|programmer|planifier|transmettre|ajouter|publier)\b/,
  },
  {
    label: 'voix passive',
    pattern: new RegExp(`\\b(?:a|ont|t'a|lui a|vous a) (?:bien |deja )?ete ${DONE_VERBS}e?s?\\b`),
  },
  { label: 'est prêt', pattern: /\best (?:pret|prete|prets|pretes)\b/ },
];

/**
 * Note ACCOLÉE à la réponse quand elle annonce un accompli qu'aucun outil n'étaye.
 *
 * ## Arbitrage : requalifier, pas bloquer
 *
 * Remplacer la réponse entière serait brutal et faux dans un cas légitime : le modèle peut
 * dire « c'est fait » en parlant d'un tour PRÉCÉDENT, où l'outil avait bel et bien tourné.
 * La détection porte sur le tour courant, pas sur l'historique — elle ne peut donc pas
 * trancher ce cas, et une réponse par ailleurs exploitable serait détruite.
 *
 * On applique le même arbitrage que pour un lien fabriqué (`sanitizeAgentOutput`) : le mal
 * est LOCAL, on le corrige localement. Ici le mal n'est pas une phrase à retirer mais une
 * ambiguïté à lever — d'où une note, et non une suppression. Elle dit exactement ce que le
 * système SAIT (« aucune action à ce tour »), jamais ce qu'il suppose.
 *
 * Le verdict complet part en `error` dans les logs, comme pour les URL fabriquées.
 */
export const UNSUPPORTED_CLAIM_NOTICE =
  "\n\n_Note : aucune action n'a été exécutée à ce tour. Si tu attendais un envoi, un document ou un enregistrement, il n'a pas eu lieu._";

/** Minuscules, accents et apostrophes typographiques normalisés — la comparaison s'y fait. */
function normalizeForClaims(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/’/g, "'");
}

/**
 * Étiquette de la formule d'accompli trouvée, ou `null`.
 *
 * Ne dit RIEN de la véracité : c'est l'appelant qui confronte ce verdict à la trace
 * d'exécution. Fonction pure, donc éprouvable des deux côtés.
 */
export function detectUnsupportedCompletionClaim(text: string): string | null {
  const normalized = normalizeForClaims(text);
  return ACCOMPLISHMENT_CLAIMS.find((claim) => claim.pattern.test(normalized))?.label ?? null;
}

/**
 * Noms des outils réellement appelés, ou `null` si la trace est illisible.
 *
 * ⚠️ La distinction `null` / `[]` est TOUT le contrat : `[]` prouve que zéro outil a tourné,
 * `null` dit seulement qu'on ne sait pas. Confondre les deux ferait accuser le modèle sur un
 * changement de forme de Mastra.
 *
 * Forme réelle vérifiée dans `@mastra/core` (`trip-wire-*.js`) : `toolCalls` est un tableau
 * de CHUNKS `{ type: 'tool-call', payload: { toolCallId, toolName, args } }`. L'ancienne
 * lecture `call.toolName ?? call.name` rendait donc « unknown » sur 100 % des 19 runs de
 * production mesurés — la longueur était juste, le nom jamais. Les deux formes plates sont
 * conservées en repli : l'observabilité ne doit jamais faire échouer une réponse produite.
 */
export function readToolCallNames(response: unknown): string[] | null {
  const calls = (response as { toolCalls?: unknown } | undefined)?.toolCalls;
  if (!Array.isArray(calls)) return null;

  return calls.map((call) => {
    const chunk = call as { payload?: { toolName?: unknown }; toolName?: unknown; name?: unknown };
    return String(chunk.payload?.toolName ?? chunk.toolName ?? chunk.name ?? 'unknown');
  });
}

/**
 * Où répondre, et donc quelle est la clé du fil.
 *
 * En canal, on threade systématiquement (thread existant, sinon on en ouvre un sur ce
 * message). En DM, threader enfouit la réponse hors de la conversation principale — le bot a
 * semblé silencieux pendant des heures en production pour cette raison exacte. On ne threade
 * donc un DM QUE si le message d'origine faisait DÉJÀ partie d'un thread (`thread_ts` présent
 * et différent de `ts` ; sinon `thread_ts` == `ts` == la racine du message courant, pas un
 * vrai thread existant).
 */
function resolveThreadTarget(
  event: SlackMessageEvent,
  channel: string,
): { isDirectMessage: boolean; threadTs?: string } {
  const isDirectMessage = event.channel_type === 'im' || channel.startsWith('D');
  const isAlreadyThreaded = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

  if (!isDirectMessage) return { isDirectMessage, threadTs: event.thread_ts ?? event.ts };
  return { isDirectMessage, threadTs: isAlreadyThreaded ? event.thread_ts : undefined };
}

/** Premier mot d'un nom complet — repli quand le profil Slack n'a pas de prénom. */
function firstWordOf(fullName: string | undefined): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? '';
}

/** Reste du nom complet — repli quand le profil Slack n'a pas de nom de famille. */
function restAfterFirstWord(fullName: string | undefined): string {
  const [, ...rest] = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return rest.join(' ');
}

/** Salutation, avec ou sans prénom connu. */
function greet(firstName: string): string {
  return firstName ? `Bienvenue ${firstName} 👋` : 'Bienvenue 👋';
}

/**
 * DM d'accueil : un mot de bienvenue et le bouton qui ouvrira la modale.
 *
 * Le `value` du bouton transporte tout ce que Slack sait déjà de l'arrivant.
 * C'est ce qui permet à la route d'interactivité d'ouvrir une modale
 * pré-remplie **sans aucune E/S** : le `trigger_id` expire en 3 secondes, et
 * refaire un `users.info` au moment du clic dépenserait ce budget pour une
 * information déjà en main.
 */
function buildWelcomeBlocks(prefill: ProfileModalPrefill): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${greet(prefill.firstName ?? '')}\n\n` +
          "Ravi de t'accueillir chez Kisso. Il me manque quelques informations " +
          'pour préparer ton intégration — deux minutes suffisent.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: COMPLETE_PROFILE_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: 'Compléter mon profil' },
          value: encodePrefill(prefill),
        },
      ],
    },
  ];
}

/** Message générique, quand on ne sait rien dire de plus utile que « ça a raté ». */
export const GENERIC_FAILURE = "Désolé, je n'ai pas réussi à traiter ton message.";

/**
 * Message posté quand les DEUX fournisseurs de modèle ont refusé la requête.
 *
 * Distinguer ce cas n'est pas du confort : c'est le seul échec où **réessayer a un sens**,
 * et le générique laissait croire à une panne. Mesuré en production le 2026-08-11 à
 * 18:21:50 UTC — Groq sur son quota JOURNALIER (`TPD: Limit 100000, Used 98207`, et non le
 * seau par minute, qui était plein) puis Mistral sur ses 4 requêtes/minute. L'utilisateur a
 * conclu à un bug et est passé au message suivant, qui a échoué pour la même raison.
 */
export const QUOTA_FAILURE =
  'Je suis à court de quota chez mes fournisseurs de modèle. Réessaie dans quelques minutes.';

/**
 * Traduit une exception en message destiné à la personne.
 *
 * Volontairement **conservateur** : tout ce qui n'est pas reconnu avec certitude reste
 * générique. Se tromper de diagnostic est pire que ne pas en donner — inviter à réessayer
 * une requête qui échouera toujours fait perdre du temps ET du quota.
 *
 * La reconnaissance porte sur le `name` du SDK (`AI_APICallError`) et sur un
 * `statusCode`/`status` à 429, jamais sur le seul texte du message : la prose d'erreur
 * change d'une version de fournisseur à l'autre, le code HTTP non. La chaîne `cause` est
 * suivie car `withChainFailureLogging` réemballe l'échec du dernier maillon.
 */
export function userFacingFailure(error: unknown): string {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const status = candidate.statusCode ?? candidate.status;
    if (status === 429) return QUOTA_FAILURE;
    if (candidate.name === 'AI_APICallError' || candidate.name === 'APICallError') {
      // Le SDK n'expose pas toujours le code : à ce stade le message est le seul indice,
      // et « rate limit » y est stable chez Groq comme chez Mistral.
      if (/rate limit|quota/i.test(String((candidate as { message?: unknown }).message ?? ''))) {
        return QUOTA_FAILURE;
      }
    }
    current = candidate.cause;
  }
  return GENERIC_FAILURE;
}

export class SlackEventsHandler {
  private slack: WebClient;
  private mastra: Mastra;
  /**
   * Déduplication des renvois Slack (timeout / 5xx → Slack rejoue l'événement).
   *
   * Le cache mémorise un STATUT, pas un simple booléen : marquer l'événement « vu » dès
   * `accept()` suffisait à bloquer tous les rejeux, y compris quand le traitement de fond
   * avait été tué en vol par le gel de la fonction serverless — l'événement était alors
   * perdu DÉFINITIVEMENT. On distingue donc `in-flight` (traitement en cours, un rejeu
   * concurrent doit bien être ignoré) de `done` (traitement terminé), et une entrée
   * `in-flight` périmée redevient rejouable.
   *
   * ATTENTION : ce cache est EN MÉMOIRE, donc par instance. En multi-instance
   * (Vercel serverless, plusieurs conteneurs) deux répliques peuvent traiter le même
   * `event_id`. La correction durable est un store partagé (Redis / LibSQL) ou une file.
   */
  private readonly seenEvents: LRUCache<string, DedupEntry>;
  private readonly inFlightGraceMs: number;
  private botUserIdPromise?: Promise<string | undefined>;
  private readonly chatProvider: Pick<SlackAdapter, 'sendBlocks'>;
  private readonly workspaceProvider: Pick<SlackWorkspaceProvider, 'getUserById'>;
  /** Évite d'inonder les logs : l'absence de `SLACK_TEAM_ID` est signalée une fois. */
  private teamIdWarningEmitted = false;
  /**
   * Mémoire conversationnelle. `undefined` signifie « pas encore construite » et
   * `null` « désactivée » — les deux états sont distincts, d'où l'union.
   */
  private conversationRepo: ConversationRepository | null | undefined;
  /**
   * Déduplication partagée. `undefined` = pas encore construite, `null` = désactivée : deux
   * états distincts, d'où l'union.
   */
  private dedupRepo: SlackEventDedupRepository | null | undefined;
  private readonly conversationTokenBudget: number;
  private readonly conversationTtlMs: number;
  /** Compteur de messages traités, pour déclencher la purge périodique. */
  private processedMessages = 0;
  /**
   * Cache des noms d'affichage Slack, par instance.
   *
   * Un `users.info` par message coûterait un aller-retour réseau sur le chemin de fond de
   * CHAQUE tour, pour une donnée qui ne change qu'exceptionnellement. Une chaîne vide
   * mémorise un échec — et l'échec doit être mis en cache comme le succès, sinon un
   * workspace qui refuse l'annuaire paie l'appel indéfiniment.
   */
  private readonly requesterNames = new LRUCache<string, string>({
    max: 500,
    ttl: 12 * 60 * 60 * 1000,
    allowStale: false,
  });

  constructor(botToken: string, mastra: Mastra, options: SlackEventsHandlerOptions = {}) {
    this.slack = options.slackClient ?? new WebClient(botToken);
    this.mastra = mastra;
    this.chatProvider = options.chatProvider ?? new SlackAdapter(botToken);
    this.workspaceProvider = options.workspaceProvider ?? new SlackWorkspaceService(botToken);
    this.inFlightGraceMs = options.inFlightGraceMs ?? DEFAULT_IN_FLIGHT_GRACE_MS;
    this.conversationRepo = options.conversationRepository;
    this.dedupRepo = options.dedupRepository;
    this.conversationTokenBudget = options.conversationTokenBudget ?? CONVERSATION_TOKEN_BUDGET;
    this.conversationTtlMs = options.conversationTtlMs ?? CONVERSATION_TTL_MS;
    this.seenEvents = new LRUCache<string, DedupEntry>({
      max: options.dedupMax ?? 1000,
      ttl: options.dedupTtlMs ?? 10 * 60 * 1000,
    });
  }

  /**
   * Dépôt de mémoire, construit paresseusement.
   *
   * Volontairement PAS dans le constructeur : le handler est instancié au chargement du
   * module par `getSlackEventsHandler`, et ouvrir une connexion Drizzle à ce moment-là
   * paierait la latence de connexion sur le chemin d'ACK — celui qui a 3 secondes.
   */
  /**
   * Dépôt de déduplication partagée, construit paresseusement.
   *
   * Même raison que pour la mémoire : le handler est instancié au chargement du module, et
   * ouvrir une connexion Drizzle à ce moment-là alourdirait le démarrage à froid — or c'est
   * précisément ce démarrage à froid (6,1 s mesurées) qui provoque les rejeux Slack que cette
   * déduplication existe pour absorber.
   */
  private getDedupRepo(): SlackEventDedupRepository | null {
    if (this.dedupRepo === undefined) {
      this.dedupRepo = new DrizzleSlackEventDedupRepository();
    }
    return this.dedupRepo;
  }

  private getConversationRepo(): ConversationRepository | null {
    if (this.conversationRepo === undefined) {
      this.conversationRepo = new DrizzleConversationRepository();
    }
    return this.conversationRepo;
  }

  /**
   * Un mot-clé matche s'il apparaît dans le texte et n'est PAS immédiatement précédé
   * d'une lettre. Régression corrigée : `String.includes('test')` matchait aussi
   * "conteste", "attester", "contestation", "protestation" — des phrases françaises
   * courantes sans rapport avec un questionnaire. Le garde-fou ne porte que sur le bord
   * GAUCHE : les suffixes (pluriels, conjugaisons — "questionnaires", "testé") continuent
   * de matcher comme avant, seul l'embarquement du mot-clé dans un mot plus long en amont
   * est exclu.
   */
  private matchesKeyword(lowerText: string, keyword: string): boolean {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Bords de mot des DEUX côtés. La garde ne portait au départ que sur le bord GAUCHE :
    // « rappelle », « messagerie », « testez » et « emails » déclenchaient tous un
    // aiguillage. Le bord droit les a écartés — mais il a aussi cassé les INFINITIFS, ce
    // que le suffixe ci-dessous rétablit, mot à mot (voir `VERB_STEM_KEYWORDS`).
    const suffix = VERB_STEM_KEYWORDS.has(keyword) ? VERB_SUFFIX_PATTERN : 's?';
    const pattern = new RegExp(`(?<![\\p{L}])${escaped}${suffix}(?![\\p{L}])`, 'u');
    return pattern.test(lowerText);
  }

  /**
   * Routage mot-clé → agent, en quatre temps. Les mots-clés sont contractuels (documentés
   * dans CLAUDE.md), ne pas les modifier sans mettre à jour la doc.
   *
   *  1. ÉCHAPPEMENT — `ESCAPE_INTENTS`, symétrique : chaque agent y a ses termes, donc
   *     aucun n'est un état absorbant. C'est la seule porte de sortie d'un fil mal aiguillé.
   *  2. COLLANT — l'agent qui mène le fil (décision D5).
   *  3. THÉMATIQUE — termes ambigus ou de suivi, ne s'appliquent qu'HORS d'un fil vivant.
   *  4. Défaut — l'orchestrateur.
   */
  routeToAgent(text: string, stickyAgentId?: string): string {
    const lowerText = (text ?? '').toLowerCase();
    const matchesAny = (keywords: readonly string[]): boolean =>
      keywords.some((keyword) => this.matchesKeyword(lowerText, keyword));

    // 1. ÉCHAPPEMENT. Prime sur le fil en cours : une demande explicite de création ou de
    // recherche doit pouvoir SORTIR d'une conversation collée sur le mauvais agent, sinon
    // le fil est un piège sans issue (acquis du 2026-08-10). Le tableau est parcouru dans
    // l'ordre, qui EST la priorité entre agents.
    for (const [agentId, keywords] of ESCAPE_INTENTS) {
      if (matchesAny(keywords)) return agentId;
    }

    // 2. COLLANT — on reste sur l'agent qui mène le fil.
    //
    // Correction du défaut central mesuré le 2026-08-11 : le routage était recalculé sur le
    // texte de CHAQUE message, isolément. Rejeu du fil réel — « Email: … » →
    // notificationAgent, « As-tu envoyé le rapport ? » → orchestrateur, « Par email » →
    // notificationAgent, « Donne le PDF alors » → orchestrateur : le fil alternait
    // A → B → A → B → A entre deux agents amnésiques. « Par email » répondait à une question
    // posée par l'orchestrateur et était livré à un agent qui ne l'avait jamais posée — d'où
    // le « Quel est l'objet de cette notification ? », qui est littéralement le schéma
    // d'entrée de `sendNotification` redemandé à zéro.
    //
    // Un identifiant inconnu du registre est IGNORÉ : le suivre aveuglément ferait lever
    // `getAgent` à chaque message et condamnerait le fil entier.
    if (stickyAgentId && KNOWN_AGENT_IDS.has(stickyAgentId)) {
      return stickyAgentId;
    }

    // 3. THÉMATIQUE — sous le collant, donc sans effet sur une réponse de suivi. L'ordre
    // reproduit celui de la bande 1 : l'orchestrateur d'abord, le questionnaire ensuite.
    if (matchesAny(ORCHESTRATOR_TOPICS)) {
      return 'onboardingOrchestrator';
    }

    if (matchesAny(QUESTIONNAIRE_TOPICS)) {
      return 'questionnaireEngine';
    }

    if (matchesAny(NOTIFICATION_TOPICS)) {
      return 'notificationAgent';
    }

    // 4. Par défaut, onboarding orchestrator
    return 'onboardingOrchestrator';
  }

  /**
   * Résout (et met en cache) l'identifiant utilisateur du bot via `auth.test()`.
   * Attendu sur le workspace Kisso Ind. (`TMLKC4EPP`) : `U0BMBEJTBMJ`.
   * Jamais codé en dur : le token peut changer de bot.
   */
  async getBotUserId(): Promise<string | undefined> {
    if (!this.botUserIdPromise) {
      this.botUserIdPromise = this.slack.auth
        .test()
        .then((res) => (res as { user_id?: string }).user_id)
        .catch((error) => {
          // Un échec ne doit pas figer le cache : on réessaiera au prochain événement.
          this.botUserIdPromise = undefined;
          logger.warn('Unable to resolve Slack bot_user_id via auth.test', { error });
          return undefined;
        });
    }
    return this.botUserIdPromise;
  }

  /**
   * Clé de déduplication : `event_id` si présent, sinon `channel:ts`.
   *
   * Un `team_join` n'a NI `channel` NI `ts` : le repli est inopérant pour lui,
   * seul `event_id` le protège du double DM de bienvenue. Slack le fournit
   * systématiquement sur une enveloppe `event_callback`.
   */
  private dedupKey(envelope: SlackEventEnvelope): string | undefined {
    const event = envelope.event;

    // `channel:ts` PRIME sur `event_id` pour les événements porteurs de texte.
    // Une même prise de parole peut produire DEUX événements aux `event_id`
    // distincts (`message` et `app_mention`), mais ils partagent toujours le
    // même `ts` dans le même canal : une seule clé, donc un seul traitement.
    // C'est la protection de fond ; la garde `duplicate_mention` ci-dessus
    // évite en plus d'ouvrir une entrée pour rien.
    if (event && !isTeamJoinEvent(event)) {
      const { channel, ts } = event;
      if (channel && ts) return `ts:${channel}:${ts}`;
    }

    // `team_join` n'a ni canal ni `ts` : seul `event_id` le protège du rejeu.
    if (envelope.event_id) return `id:${envelope.event_id}`;
    return undefined;
  }

  /**
   * Décision SYNCHRONE prise avant l'ACK HTTP.
   *
   * Règles :
   *  - `app_mention` → traité (mention du bot dans un canal).
   *  - `message` → traité UNIQUEMENT si `channel_type === 'im'` (message direct).
   *    C'est aussi ce qui empêche la double réponse : quand on mentionne le bot dans un
   *    canal, Slack émet À LA FOIS `app_mention` ET `message` (`channel_type: 'channel'`).
   *    En n'acceptant `message` que pour les DM, un seul des deux passe.
   *  - Tout message émis par un bot est ignoré (anti-boucle infinie).
   */
  async accept(
    envelope: SlackEventEnvelope,
    context: SlackAcceptContext = {},
  ): Promise<SlackEventDecision> {
    if (envelope.type !== 'event_callback') {
      return { action: 'ignore', reason: 'not_event_callback' };
    }

    const event = envelope.event;
    if (!event) {
      return { action: 'ignore', reason: 'no_event' };
    }

    if (!event.type || !SUPPORTED_EVENT_TYPES.has(event.type)) {
      return { action: 'ignore', reason: 'unsupported_event_type' };
    }

    const wrongTeam = this.checkTeamId(envelope);
    if (wrongTeam) return wrongTeam;

    const rejected = isTeamJoinEvent(event)
      ? this.rejectTeamJoin(event)
      : this.rejectMessage(event);
    if (rejected) return { action: 'ignore', reason: rejected };

    const key = this.dedupKey(envelope);
    if (key && !(await this.claimEvent(key, context.retryNum))) {
      return { action: 'ignore', reason: 'duplicate' };
    }

    return { action: 'process', event };
  }

  /**
   * Prend la clé d'un événement, ou refuse — en DEUX niveaux.
   *
   * 1. **Cache local (LRU).** Écarte sans aucune E/S les rejeux qui retombent sur la MÊME
   *    instance. Gratuit, et c'est le cas le plus fréquent quand l'instance est chaude.
   * 2. **Store partagé (Turso).** Le seul capable d'écarter un rejeu routé vers une AUTRE
   *    instance. C'est précisément ce qui manquait le 2026-08-11 : l'instance A était occupée
   *    par le `waitUntil` de l'appel LLM, donc le rejeu Slack (`retryNum: "1"`, provoqué par
   *    un ACK à 6,7 s sur démarrage à froid) est parti sur une instance NEUVE, au cache vide,
   *    qui a répondu une seconde fois avec un texte différent.
   *
   * **Dégradation assumée** : si le store partagé est indisponible, on retombe sur le seul
   * cache local et on ACCEPTE l'événement. L'arbitrage est explicite — un doublon possible
   * vaut mieux qu'un message perdu, car le doublon est visible et corrigeable tandis que le
   * silence ne l'est pas. La ligne est journalisée en `error` : c'est celle à chercher si les
   * doubles réponses reviennent.
   */
  private async claimEvent(key: string, retryNum?: string | null): Promise<boolean> {
    const local = this.claimLocally(key, retryNum);
    if (!local) return false;

    const repo = this.getDedupRepo();
    if (!repo) return true;

    try {
      const claim = await repo.claim(key, { inFlightGraceMs: this.inFlightGraceMs });

      if (!claim.granted) {
        // Une AUTRE instance mène ou a mené le traitement. On relâche notre prise locale :
        // la garder en `in-flight` bloquerait localement un rejeu qui redeviendrait pourtant
        // légitime après la grâce d'abandon.
        this.seenEvents.delete(key);
        logger.info('Dropping duplicate Slack event (claimed by another instance)', {
          key,
          status: claim.status,
          ageMs: claim.ageMs,
          retryNum: retryNum ?? undefined,
        });
        return false;
      }

      if (claim.reclaimed) {
        // Symptôme d'une invocation tuée en vol : le traitement précédent n'a jamais rendu
        // la main et la grâce a expiré.
        logger.warn('Reprocessing an abandoned Slack event (shared claim)', {
          key,
          retryNum: retryNum ?? undefined,
        });
      }

      return true;
    } catch (error) {
      logger.error('Shared Slack dedup unavailable — falling back to the per-instance cache', {
        error,
        key,
        retryNum: retryNum ?? undefined,
      });
      return true;
    }
  }

  /**
   * Volet local de la prise de clé. Conserve à l'identique la sémantique d'origine, qui est
   * le fruit d'un bug déjà corrigé : une entrée `in-flight` plus vieille que la durée de vie
   * maximale d'une invocation ne peut plus correspondre à un traitement vivant (fonction gelée
   * ou tuée), donc l'événement redevient rejouable plutôt que d'être perdu DÉFINITIVEMENT.
   */
  private claimLocally(key: string, retryNum?: string | null): boolean {
    const existing = this.seenEvents.get(key);

    if (existing) {
      const ageMs = Date.now() - existing.startedAt;
      const abandoned = existing.status === 'in-flight' && ageMs >= this.inFlightGraceMs;

      if (!abandoned) {
        logger.info('Dropping duplicate Slack event', {
          key,
          status: existing.status,
          ageMs,
          retryNum: retryNum ?? undefined,
        });
        return false;
      }

      logger.warn('Reprocessing abandoned Slack event', {
        key,
        ageMs,
        retryNum: retryNum ?? undefined,
      });
    }

    this.seenEvents.set(key, { status: 'in-flight', startedAt: Date.now() });
    return true;
  }

  /**
   * Vérifie que l'événement vient bien du workspace attendu.
   *
   * Délibérément **fail-open** : `SLACK_TEAM_ID` n'est définie ni localement ni
   * en production, donc rejeter en son absence couperait 100 % du trafic Slack
   * — silencieusement, la route rendant `200` en toute circonstance, et sans
   * qu'aucun test ne vire au rouge. La signature HMAC lie déjà chaque requête
   * au *signing secret* de cette app, qui n'est installée que sur un seul
   * workspace : ce contrôle n'est qu'une défense en profondeur.
   *
   * Pour passer en fail-closed : déclarer `SLACK_TEAM_ID` dans Vercel, redéployer,
   * confirmer l'absence d'avertissement dans les logs, PUIS durcir ici.
   */
  private checkTeamId(envelope: SlackEventEnvelope): SlackEventDecision | undefined {
    const expected = process.env.SLACK_TEAM_ID?.trim();

    if (!expected) {
      if (!this.teamIdWarningEmitted) {
        this.teamIdWarningEmitted = true;
        logger.warn(
          'SLACK_TEAM_ID is not set — cross-workspace check disabled (fail-open by design)',
        );
      }
      return undefined;
    }

    if (envelope.team_id && envelope.team_id !== expected) {
      logger.warn('Dropping Slack event from an unexpected workspace', {
        received: envelope.team_id,
        expected,
      });
      return { action: 'ignore', reason: 'wrong_team' };
    }

    return undefined;
  }

  /** Motifs de rejet propres aux messages. `undefined` = accepté. */
  private rejectMessage(event: SlackMessageEvent): SlackIgnoreReason | undefined {
    // Un message de canal passe s'il RÉPOND DANS UN FIL — et seulement dans ce cas.
    //
    // Le filtre d'origine (`channel_type !== 'im'` → rejet sec) était plus large que son
    // motif. Il existait pour empêcher la double réponse d'une mention, qui émet à la fois
    // `message` et `app_mention` : or ce doublon est DÉJÀ traité par `dedupKey`, qui préfère
    // `ts:<channel>:<ts>` à `event_id` et unifie donc les deux événements. Son effet de bord,
    // lui, était majeur : sans re-mention à chaque tour, toute la mémoire conversationnelle
    // était INERTE en canal.
    //
    // La restriction au fil est ce qui rend l'ouverture tenable : le bot est membre de
    // #kisso-hq et #engineer-karyl, et accepter toute prise de parole y brûlerait le quota
    // (≈ 19 messages/jour chez Groq) en quelques échanges. Le message RACINE d'un fil est
    // exclu (`thread_ts === ts`) : c'est une prise de parole neuve, pas une réponse.
    //
    // ⚠️ Aucune lecture en base ici : `accept()` est le chemin d'ACK, il a 3 secondes. La
    // vérification « le bot a-t-il déjà parlé dans ce fil ? » se fait en tâche de fond,
    // dans `handleMessage`.
    if (event.type === 'message' && event.channel_type !== 'im') {
      const isThreadReply = Boolean(event.thread_ts) && event.thread_ts !== event.ts;
      if (!isThreadReply) return 'not_a_dm';
    }

    // Symétrique du filtre ci-dessus, pour les DM. Mentionner le bot dans un DM
    // émet À LA FOIS `message` (channel_type 'im') et `app_mention` : on garde
    // le premier, on écarte le second. Sans cela le bot répond DEUX FOIS —
    // observé en production le 2026-08-10.
    //
    // Le test porte sur le préfixe `D` du canal et NON sur `channel_type` :
    // le payload `app_mention` de Slack ne porte pas ce champ (vérifié dans
    // `@slack/types`, `AppMentionEvent` déclare `ts`, `channel`, `event_ts`).
    if (event.type === 'app_mention' && event.channel?.startsWith('D')) {
      return 'duplicate_mention';
    }

    // Anti-boucle : les indices synchrones. `user === bot_user_id` est vérifié plus tard
    // (nécessite un appel réseau `auth.test()`).
    if (event.bot_id || event.subtype === 'bot_message' || event.bot_profile) {
      return 'bot_message';
    }

    // Les autres sous-types (`message_changed`, `channel_join`, `message_deleted`, …)
    // ne sont pas des messages utilisateur adressés au bot.
    if (event.type === 'message' && event.subtype) {
      return 'unsupported_event_type';
    }

    if (!this.cleanText(event.text)) {
      return 'empty_text';
    }

    return undefined;
  }

  /**
   * Motifs de rejet propres à `team_join`. `undefined` = accepté.
   *
   * Aucune des gardes de `rejectMessage` ne s'applique ici : `bot_id`,
   * `subtype`, `bot_profile` et `text` sont des champs de *message*, absents
   * d'un `team_join`. Sans les gardes ci-dessous, le bot ouvrirait un DM à
   * chaque application installée — et la garde `empty_text` rejetterait au
   * contraire 100 % des arrivées réelles.
   */
  private rejectTeamJoin(event: SlackTeamJoinEvent): SlackIgnoreReason | undefined {
    const user = event.user;

    if (!user?.id) return 'no_user';

    if (user.is_bot || user.is_app_user || user.is_workflow_bot || user.id === SLACKBOT_USER_ID) {
      return 'bot_join';
    }

    if (user.deleted) return 'deleted_user';

    // Décision métier assumée : un invité MONO-canal (`is_ultra_restricted`) et
    // un externe Slack Connect (`is_stranger`) ne sont jamais des embauches
    // Kisso. L'invité MULTI-canal (`is_restricted`) passe en revanche — ce sont
    // les prestataires, qui suivent bien le parcours d'intégration.
    if (user.is_ultra_restricted || user.is_stranger) return 'restricted_user';

    return undefined;
  }

  /**
   * Le traitement est allé au bout : tout rejeu ultérieur doit être ignoré.
   *
   * Les deux niveaux sont mis à jour. L'échec du niveau partagé n'est pas fatal — il laisse
   * la clé en `in-flight`, donc reprenable après la grâce d'abandon, ce qui est le
   * comportement le moins dommageable.
   */
  private async markDedupDone(key: string | undefined): Promise<void> {
    if (!key) return;
    this.seenEvents.set(key, { status: 'done', startedAt: Date.now() });

    const repo = this.getDedupRepo();
    if (!repo) return;
    try {
      await repo.markDone(key);
    } catch (error) {
      logger.warn('Unable to mark the shared Slack dedup key as done', { error, key });
    }
  }

  /**
   * Le traitement a échoué de façon inattendue : on libère la clé pour qu'un rejeu Slack
   * puisse repartir immédiatement au lieu d'être avalé par la déduplication.
   */
  private async releaseDedup(key: string | undefined): Promise<void> {
    if (!key) return;
    this.seenEvents.delete(key);

    const repo = this.getDedupRepo();
    if (!repo) return;
    try {
      await repo.release(key);
    } catch (error) {
      logger.warn('Unable to release the shared Slack dedup key', { error, key });
    }
  }

  /**
   * Purge de rétention de la déduplication, en tâche de fond. Même cadence et même
   * raisonnement que `schedulePruneIfDue()` pour la mémoire : pas de cron dans ce projet, et
   * une purge un message sur cent suffit à borner la table.
   */
  private scheduleDedupPruneIfDue(): void {
    if (this.processedMessages % PRUNE_EVERY_N_MESSAGES !== 0) return;

    const repo = this.getDedupRepo();
    if (!repo) return;

    void repo
      .prune(new Date(Date.now() - SLACK_EVENT_DEDUP_RETENTION_MS))
      .then((removed) => logger.info('Pruned expired Slack dedup keys', { removed }))
      .catch((error) => logger.warn('Slack dedup prune failed', { error }));
  }

  /**
   * Retire la mention DU BOT et normalise les espaces.
   *
   * ⚠️ Ne retire plus TOUTES les mentions. `@mastra crée un profil pour <@U0AWA>` devenait
   * « crée un profil pour » : le SUJET de la demande disparaissait du message avant même
   * d'atteindre le modèle, qui n'avait alors plus qu'un seul humain à qui rattacher un
   * pronom — celui à qui il parlait. Les mentions de TIERS sont donc conservées telles
   * quelles ; Slack les affiche, `wrapAgentInput` les laisse passer intactes (vérifié) et
   * `sanitizeAgentOutput` ne touche pas aux jetons `<@U…>`.
   *
   * `botUserId` est `undefined` sur le chemin d'ACK (`rejectMessage`), qui n'a pas les 3
   * secondes nécessaires à un `auth.test()` : on y retombe sur l'ancien comportement, sans
   * conséquence — ce texte n'y sert qu'à décider si le message est vide.
   */
  private cleanText(text: string | undefined, botUserId?: string): string {
    // Le nettoyage de `botUserId` n'est pas cosmétique : la valeur vient de `auth.test()`,
    // donc du réseau, et elle est interpolée dans une expression régulière.
    const mentions = botUserId
      ? new RegExp(`<@${botUserId.replace(/[^A-Z0-9]/gi, '')}>`, 'g')
      : /<@[A-Z0-9]+>/g;

    return (text ?? '').replace(mentions, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Nom d'affichage du demandeur, mis en cache. **Ne rejette jamais.**
   *
   * L'annuaire est un confort : sans lui, le préambule se rabat sur la seule mention
   * `<@U…>`, qui suffit déjà à empêcher « tu » de se résoudre sur un tiers. Les échecs sont
   * mémorisés au même titre que les succès — un workspace qui refuse `users.info` ne doit
   * pas coûter un aller-retour réseau à chaque message.
   */
  private async resolveRequesterName(slackUserId: string | undefined): Promise<string> {
    if (!slackUserId) return '';

    const cached = this.requesterNames.get(slackUserId);
    if (cached !== undefined) return cached;

    let resolved = '';
    try {
      const member = await this.workspaceProvider.getUserById(slackUserId);
      resolved = sanitizeDisplayName(
        member?.realName || [member?.firstName, member?.lastName].filter(Boolean).join(' '),
      );
    } catch (error) {
      logger.debug('Unable to resolve the Slack display name — falling back to the user id', {
        slackUserId,
        error,
      });
    }

    this.requesterNames.set(slackUserId, resolved);
    return resolved;
  }

  /**
   * Traitement de fond (après l'ACK). Ne jamais `await` depuis la route HTTP.
   *
   * C'est ICI, et seulement ici, que la clé de déduplication passe de `in-flight` à
   * `done` : tant que ce point n'est pas atteint, un rejeu Slack reste recevable.
   */
  async handleEvent(envelope: SlackEventEnvelope): Promise<void> {
    const key = this.dedupKey(envelope);
    try {
      await this.processEvent(envelope);
      await this.markDedupDone(key);
    } catch (error) {
      // Échec inattendu : la clé est libérée pour que Slack puisse rejouer.
      await this.releaseDedup(key);
      throw error;
    }
  }

  private async processEvent(envelope: SlackEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (!event) return;

    // L'aiguillage précède délibérément `getBotUserId()` : c'est un aller-retour
    // réseau (`auth.test()`) sans objet sur ce chemin — la boucle « le bot poste
    // en tant qu'utilisateur » n'existe pas pour une arrivée, et le cas « un bot
    // rejoint le workspace » est déjà filtré par `rejectTeamJoin`, sans réseau.
    if (isTeamJoinEvent(event)) {
      await this.handleTeamJoin(event);
      return;
    }

    // Dernière garde anti-boucle : le bot pourrait poster en tant qu'utilisateur.
    const botUserId = await this.getBotUserId();
    if (botUserId && event.user === botUserId) {
      logger.debug('Ignoring own Slack message', { botUserId });
      return;
    }

    await this.handleMessage(event);
  }

  /**
   * Ouvre un DM de bienvenue portant le bouton « Compléter mon profil ».
   *
   * Aucun LLM sur ce chemin : la modale collectera les données, et le workflow
   * sera appelé en code. Coût : zéro token.
   *
   * N'échoue jamais vers l'appelant — `handleEvent` relance l'exception et
   * libère la clé de déduplication, ce qui ferait rejouer Slack et enverrait un
   * SECOND DM de bienvenue, visible par la personne.
   */
  async handleTeamJoin(event: SlackTeamJoinEvent): Promise<void> {
    const user = event.user;
    if (!user?.id) {
      logger.warn('team_join without a user id, skipping');
      return;
    }

    try {
      const identity = await this.resolveNewcomer(user);
      logger.info('Welcoming a newcomer', {
        userId: user.id,
        hasEmail: Boolean(identity.email),
      });

      await this.chatProvider.sendBlocks(
        user.id,
        greet(identity.firstName ?? ''),
        buildWelcomeBlocks(identity),
      );
    } catch (error) {
      logger.error('Unable to send the welcome DM', { error, userId: user.id });
    }
  }

  /**
   * Ce que Slack sait déjà de l'arrivant, pour pré-remplir la modale.
   *
   * L'email manque souvent du payload `team_join` tant que le profil n'est pas
   * complété : on ne paie le second aller-retour `users.info` que dans ce cas.
   * Son échec ne bloque pas — le DM part sur l'identifiant Slack et la modale
   * collectera l'email.
   */
  private async resolveNewcomer(user: SlackTeamJoinUser): Promise<ProfileModalPrefill> {
    const fromPayload: ProfileModalPrefill = {
      slackUserId: user.id ?? '',
      firstName: user.profile?.first_name || firstWordOf(user.real_name),
      lastName: user.profile?.last_name || restAfterFirstWord(user.real_name),
      email: user.profile?.email ?? null,
    };

    if (fromPayload.email || !user.id) return fromPayload;

    try {
      const member = await this.workspaceProvider.getUserById(user.id);
      if (!member) return fromPayload;
      return {
        slackUserId: fromPayload.slackUserId,
        firstName: fromPayload.firstName || member.firstName,
        lastName: fromPayload.lastName || member.lastName,
        email: member.email,
      };
    } catch (error) {
      logger.warn('Directory lookup failed for a newcomer, continuing without email', {
        error,
        userId: user.id,
      });
      return fromPayload;
    }
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const { user, channel } = event;

    // Garde défensive : `handleMessage` peut être appelé directement.
    if (event.bot_id || event.subtype === 'bot_message') {
      logger.debug('Ignoring bot message', { botId: event.bot_id });
      return;
    }

    if (!channel) {
      logger.warn('Slack event without channel, skipping', { user });
      return;
    }

    // La promesse est déjà résolue sur ce chemin (`processEvent` l'a attendue), donc gratuit.
    const botUserId = await this.getBotUserId();
    const text = this.cleanText(event.text, botUserId);

    const { isDirectMessage, threadTs } = resolveThreadTarget(event, channel);

    // Clé du fil. En DM `threadTs` est `undefined` par conception (voir plus haut), donc
    // la conversation EST le canal ; en canal, c'est le thread.
    const conversationId = deriveConversationId({ channel, threadTs });

    // Lancée SANS `await` : la résolution du nom se recouvre avec la lecture de la mémoire
    // au lieu de s'y ajouter. Elle ne rejette jamais (cf. `resolveRequesterName`).
    const requesterName = this.resolveRequesterName(user);

    // ⚠️ L'historique est chargé AVANT le marqueur de progression, et c'est nécessaire :
    // un fil de canal non engagé est abandonné juste en dessous, et poster « Je regarde
    // ça… » pour l'effacer aussitôt laisserait un message orphelin dans le fil. Le surcoût
    // (une lecture Turso) est négligeable devant les 2 à 17 s d'un run.
    const history = await this.loadHistory(conversationId);

    if (this.shouldAbandonThreadReply(event, isDirectMessage, history, botUserId)) {
      logger.info('Ignoring a channel thread reply: the bot has never spoken in this thread', {
        channel,
        threadTs,
        historyTurns: history.length,
      });
      return;
    }

    logger.info('Processing Slack message', { user, channel, text });

    // Marqueur de progression posté IMMÉDIATEMENT, avant tout appel LLM. Un run prend 2 à
    // 17 s (jusqu'à ~21 s quand le back-off du dernier maillon se déclenche), pendant
    // lesquelles le bot paraissait totalement muet. `startProgress` ne bloque pas : il rend
    // la main sans attendre l'aller-retour Slack, et la réponse finale REMPLACE le marqueur
    // — un seul message dans le fil, jamais deux.
    const progress = await startProgress(this.slack, { channel, threadTs });
    const postMessage = (payload: { channel: string; text: string }) =>
      progress.resolve(payload.text);

    // Phase courante du traitement. Le catch générique ci-dessous couvrait cinq points
    // d'échec très différents — chaîne LLM épuisée, exception d'outil, `SecurityBlockError`
    // de `wrapAgentInput`, agent introuvable, échec de publication Slack — et les rendait
    // tous sous le même « Désolé, une erreur s'est produite », sans rien pour les
    // distinguer dans les logs. C'est ce qui a rendu l'incident du 2026-08-11 opaque.
    let phase: 'route' | 'resolve-agent' | 'wrap' | 'generate' | 'sanitize' | 'post' = 'route';
    let agentId = 'unknown';

    try {
      // La collance lit le DERNIER tour de l'historique BRUT, pas de la fenêtre : un fil
      // peut dépasser le budget de contexte sans pour autant avoir changé d'interlocuteur.
      const stickyAgentId = history.at(-1)?.agentId;
      agentId = this.routeToAgent(text, stickyAgentId);
      logger.info('Routing to agent', {
        agentId,
        stickyAgentId: stickyAgentId ?? null,
        sticky: Boolean(stickyAgentId) && agentId === stickyAgentId,
        historyTurns: history.length,
      });

      phase = 'resolve-agent';
      const agent = this.tryGetAgent(agentId);
      if (!agent) {
        await postMessage({
          channel,
          text: `Agent ${agentId} non disponible. Veuillez contacter l'administrateur.`,
        });
        return;
      }

      phase = 'wrap';
      // Le texte Slack est une entrée UTILISATEUR non fiable : on l'encadre (délimiteurs,
      // détection d'injection, neutralisation Unicode) avant de le transmettre au LLM.
      // Peut lever `SecurityBlockError` — et c'est voulu : un message bloqué ne doit
      // atteindre ni le modèle, ni la mémoire (décision D4).
      const safeInput = wrapAgentInput(text);

      // Le tour utilisateur est mémorisé AVANT l'appel du modèle, et seulement après que
      // l'encadrement a réussi. Si la chaîne LLM échoue, la question reste connue : la
      // personne reformule et le bot a toujours le contexte, au lieu de repartir de zéro
      // exactement au moment où ça se passe mal.
      //
      // ⚠️ On mémorise le texte ASSAINI, pas le texte brut. La différence n'est pas
      // cosmétique : un message hostile portant un faux délimiteur (`<kisso_XXXX_user_input>`)
      // serait sinon stocké tel quel, puis rejoué NON ENCADRÉ à chaque tour suivant du fil —
      // une injection qui se persiste et se répète, exactement ce que la mémoire ne doit
      // jamais permettre. `wrapAgentInput` a déjà neutralisé le contenu ; on ne conserve
      // que ce qu'il a validé.
      await this.rememberTurn({
        conversationId,
        role: 'user',
        content: unwrapSanitizedInput(safeInput, text),
        agentId,
        slackUserId: user ?? null,
      });

      phase = 'generate';
      const startedAt = Date.now();
      // Le contexte Slack descend jusqu'aux tools par le `requestContext` de Mastra — le seul
      // canal qui n'entre PAS dans la fenêtre du modèle. Sans lui, un tool n'a aucun moyen de
      // savoir où livrer un fichier : c'est ce vide qui a produit le faux lien
      // `https://kisso.internal/docs/<uuid>/download` du 2026-08-11.
      //
      // ⚠️ On transmet la variable `threadTs` DÉJÀ calculée plus haut, jamais `thread_ts` ni
      // `ts` du payload : en DM elle vaut `undefined` par conception, et un fichier uploadé
      // avec un `thread_ts` en DM serait enfoui hors de la conversation principale —
      // exactement le défaut qui a fait paraître le bot muet pendant des heures.
      const response = await agent.generate(
        this.buildMessages(history, safeInput, {
          agentId,
          slackUserId: user,
          displayName: await requesterName,
        }),
        {
          requestContext: buildSlackRequestContext({ channel, threadTs, slackUserId: user }),
        },
      );
      const durationMs = Date.now() - startedAt;

      phase = 'sanitize';
      // Point de passage UNIQUE de toute réponse d'agent vers Slack. C'est ici,
      // et nulle part ailleurs, qu'on garantit qu'aucun marqueur interne ne
      // franchit la frontière et que le style est bien du mrkdwn Slack.
      // Les instructions et le prompt système n'y suffisent pas : la campagne du
      // 2026-08-10 a vu passer le délimiteur `kisso_XXXX`, le marqueur
      // `[SECURITY_BLOCK]` et du markdown GitHub, tous explicitement proscrits.
      const safeOutput = sanitizeAgentOutput(response.text);

      this.logSanitizerVerdicts(safeOutput, { agentId, channel });

      // RÉCONCILIATION FAIT / NARRATION.
      //
      // Ce point est le SEUL du code qui voit à la fois la réponse du modèle et la trace
      // d'exécution : jusqu'ici il journalisait la seconde et postait la première sans
      // jamais les confronter. Le défaut produit numéro un, formulé par l'utilisatrice
      // testeuse, tient en une phrase : « il parle exactement de la même façon quand il a
      // fait le travail et quand il l'a inventé ».
      //
      // On ne juge PAS la vraisemblance, on constate une CONTRADICTION : une réponse qui
      // affirme un accompli alors que la trace prouve que zéro outil a tourné est fausse par
      // construction. `null` (trace illisible) n'est pas `[]` (zéro appel) — sans preuve
      // positive, on se tait.
      const toolCalls = readToolCallNames(response);
      const unsupportedClaim =
        toolCalls?.length === 0 ? detectUnsupportedCompletionClaim(safeOutput.text) : null;

      if (unsupportedClaim) {
        // Niveau `error`, comme pour les URL fabriquées : c'est le même genre de faute — le
        // modèle affirme une réalité que le système peut démentir.
        logger.error('Agent claimed a completed action while no tool ran — response requalified', {
          agentId,
          channel,
          conversationId,
          claim: unsupportedClaim,
        });
      }

      // Mémorisé APRÈS assainissement : sans cela, l'unique filet anti-marqueurs serait
      // contourné et un `kisso_XXXX` capté une fois se rejouerait à chaque tour suivant.
      //
      // ⚠️ La note de requalification n'entre PAS en mémoire, délibérément : c'est une
      // affordance destinée à l'humain, pas un tour de dialogue. La rejouer apprendrait au
      // modèle à imiter le démenti, et coûterait ses tokens à chaque tour suivant — sur un
      // budget quotidien de ≈ 19 messages.
      await this.rememberTurn({
        conversationId,
        role: 'assistant',
        content: safeOutput.text,
        agentId,
        slackUserId: null,
      });

      phase = 'post';
      await postMessage({
        channel,
        text: unsupportedClaim ? safeOutput.text + UNSUPPORTED_CLAIM_NOTICE : safeOutput.text,
      });

      // Ce que le log ne disait pas et qu'il fallait deviner : combien d'étapes le run a
      // coûté, quels outils ont réellement tourné, et combien de tokens d'entrée ont été
      // brûlés. Sans `toolCalls`, « Le PDF a été généré » est indiscernable d'une pure
      // narration du modèle. Coût : zéro token.
      logger.info('Slack response sent', {
        channel,
        agentId,
        conversationId,
        redacted: safeOutput.redacted.length,
        durationMs,
        steps: this.readSteps(response),
        inputTokens: this.readInputTokens(response),
        toolCalls,
        unsupportedClaim,
      });

      this.schedulePruneIfDue();
      this.scheduleDedupPruneIfDue();
    } catch (error) {
      // `error.constructor.name` est conservé explicitement : `maskPii` remplace la pile
      // par la constante `[STACK_TRACE]` et ne garde que `name`/`message`/`cause`, ce qui
      // ne suffit pas à distinguer un `SecurityBlockError` d'un échec de la chaîne LLM.
      logger.error('Error processing Slack message', {
        error,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        phase,
        agentId,
        conversationId,
        channel,
        text,
        user,
      });

      // `fail()` ne lève jamais : il est déjà sur le chemin d'erreur, et y remplacer une
      // exception par une autre effacerait la cause d'origine.
      await progress.fail(userFacingFailure(error));
    }
  }

  /**
   * Journalise ce que le filtre de sortie a retiré. Aucun effet sur la réponse : elle est
   * déjà nettoyée quand on arrive ici.
   */
  private logSanitizerVerdicts(
    safeOutput: { redacted: string[]; strippedUrls: string[] },
    context: { agentId: string; channel: string },
  ): void {
    if (safeOutput.redacted.length > 0) {
      // Niveau `error` volontaire : une fuite de marqueur signifie que le modèle a été amené
      // à parler de son propre garde-fou. C'est la ligne à chercher dans les logs après une
      // tentative d'extraction de prompt.
      logger.error('Agent output carried internal markers — response replaced', {
        ...context,
        markers: safeOutput.redacted,
      });
    }

    if (safeOutput.strippedUrls.length > 0) {
      // Un lien fabriqué n'est PAS une fuite : la réponse reste utile, seul le lien est
      // retiré. Le niveau `error` est néanmoins volontaire — c'est la ligne qui aurait fait
      // tomber en minutes le faux `https://kisso.internal/docs/<uuid>/download` du
      // 2026-08-11. Seuls les HÔTES sont journalisés : le chemin d'un lien inventé embarque
      // un identifiant réel, inutile à déverser dans les logs.
      logger.error('Agent output carried fabricated links — links removed', {
        ...context,
        hosts: safeOutput.strippedUrls,
      });
    }
  }

  /**
   * Second volet de l'ouverture aux fils de canal — le premier est dans `rejectMessage`.
   *
   * `accept()` a laissé passer une réponse de fil sans pouvoir vérifier qu'elle nous
   * concerne : c'est le chemin d'ACK, il n'a pas le droit de lire en base (3 secondes). On
   * tranche donc ici, en tâche de fond : **le bot ne prend la parole que dans un fil où il a
   * DÉJÀ répondu.**
   *
   * Sans cette garde, chaque phrase échangée entre humains dans un fil de #kisso-hq
   * deviendrait un run LLM — le quota Groq est de ≈ 19 messages par JOUR. Le TTL de la
   * mémoire (60 min) borne l'engagement par-dessus : un fil retombé dans le silence
   * redemande une mention explicite.
   *
   * Dégradation assumée : mémoire indisponible → historique vide → abandon. C'est le sens le
   * moins coûteux, et le seul honnête — sans mémoire, le bot n'a de toute façon aucun
   * contexte à continuer. Un `app_mention` n'est jamais concerné : la mention EST le mandat.
   */
  private shouldAbandonThreadReply(
    event: SlackMessageEvent,
    isDirectMessage: boolean,
    history: readonly ConversationTurn[],
    botUserId: string | undefined,
  ): boolean {
    if (event.type !== 'message' || isDirectMessage) return false;

    // ⚠️ Le JUMEAU `message` d'une mention en canal doit rester traité.
    //
    // Une mention émet à la fois `app_mention` et `message`, et les deux partagent
    // `channel:ts` — donc UNE SEULE clé de déduplication. Avant l'ouverture aux fils, le
    // jumeau était écarté par `rejectMessage`, avant toute prise de clé ; il peut désormais
    // la prendre le premier. L'abandonner ici ferait ensuite écarter l'`app_mention` comme
    // doublon, et la mention resterait SANS RÉPONSE — une régression pire que le défaut
    // qu'on corrige. Un message qui mentionne le bot porte son propre mandat, fil engagé
    // ou non.
    if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return false;

    return !history.some((turn) => turn.role === 'assistant');
  }

  /**
   * Résout un agent du registre Mastra, ou `undefined`.
   *
   * `mastra.getAgent()` LÈVE (`MASTRA_GET_AGENT_BY_NAME_NOT_FOUND`) au lieu de rendre
   * `undefined` : l'ancien `if (!agent)` posé sur son résultat était donc du code MORT, et
   * un identifiant erroné retombait sur le « Désolé, une erreur s'est produite » générique
   * du catch — un piège de diagnostic actif. On rattrape l'exception ici.
   *
   * La garde `!agent` est conservée en aval malgré tout : c'est une double sécurité contre
   * un changement de contrat de Mastra, dans les deux sens.
   */
  private tryGetAgent(agentId: string) {
    try {
      return this.mastra.getAgent(agentId);
    } catch (error) {
      logger.error('Agent not found in the Mastra registry', { agentId, error });
      return undefined;
    }
  }

  /* ----------------------------------------------------------------------- *
   * Mémoire conversationnelle
   * ----------------------------------------------------------------------- */

  /**
   * Historique récent du fil. **N'échoue jamais vers l'appelant** : une mémoire
   * indisponible doit dégrader le bot vers son comportement d'avant — amnésique mais
   * fonctionnel — et surtout pas le rendre muet. C'est notamment le cas tant que la table
   * `conversation_turns` n'a pas été appliquée sur la base de production.
   */
  private async loadHistory(conversationId: string): Promise<ConversationTurn[]> {
    const repo = this.getConversationRepo();
    if (!repo) return [];

    try {
      return await repo.recentTurns(conversationId, {
        ttlMs: this.conversationTtlMs,
        limit: CONVERSATION_QUERY_LIMIT,
      });
    } catch (error) {
      logger.warn('Unable to load conversation history — continuing without memory', {
        error,
        conversationId,
      });
      return [];
    }
  }

  /** Persiste un tour. Même contrat que `loadHistory` : jamais fatal. */
  private async rememberTurn(turn: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    agentId: string;
    slackUserId: string | null;
  }): Promise<void> {
    const repo = this.getConversationRepo();
    if (!repo) return;

    try {
      await repo.append(turn);
    } catch (error) {
      logger.warn('Unable to persist a conversation turn', {
        error,
        conversationId: turn.conversationId,
        role: turn.role,
      });
    }
  }

  /**
   * Messages transmis au modèle : l'historique fenêtré, puis le message courant.
   *
   * ⚠️ L'historique n'est PAS ré-encadré, et c'est délibéré.
   * `validateDelimiterIntegrity` rejette toute seconde balise ouvrante, donc
   * `history.map(wrapAgentInput)` lèverait `SecurityBlockError` sur chaque message. Un
   * SEUL bloc `<kisso_XXXX_user_input>` existe par appel, porté par le message courant —
   * c'est exactement ce que les DIRECTIVE 3.1/3.2 annoncent au modèle (« le bloc balisé
   * ajouté sous ce prompt »). L'historique voyage en messages structurés, où le rôle
   * porte déjà la distinction système / utilisateur.
   *
   * Ce qui rend l'absence d'encadrement sûre, c'est le point d'écriture : un tour `user`
   * n'entre en mémoire qu'après un `wrapAgentInput` réussi, et un tour `assistant`
   * qu'après `sanitizeAgentOutput`. Rien de bloqué ne peut donc être rejoué.
   */
  private buildMessages(
    history: readonly ConversationTurn[],
    wrappedCurrentInput: string,
    context: { agentId: string; slackUserId?: string; displayName: string },
  ) {
    const window = selectWindow(history, this.conversationTokenBudget);

    // Fenêtrage AVANT construction du préambule : l'avertissement d'attribution ne doit être
    // payé (≈ 35 tokens) que si un tour étranger survit réellement au budget de tokens.
    const preamble = buildContextPreamble({
      slackUserId: context.slackUserId,
      displayName: context.displayName,
      hasForeignTurns: window.some(
        (turn) => turn.role === 'assistant' && turn.agentId !== context.agentId,
      ),
    });

    // La ternaire produit une union de types LITTÉRAUX (`{role:'user'}` | `{role:'assistant'}`)
    // là où un `{ role: turn.role }` produirait `role: 'user' | 'assistant'` sur un seul
    // objet — non assignable à `MessageListInput`, qui attend un membre discriminé.
    const replayed = window.map((turn) =>
      turn.role === 'assistant'
        ? ({
            role: 'assistant',
            // ARBITRAGE — on garde le tour d'un autre agent, mais on le DÉSIGNE.
            //
            // Filtrer l'historique par `agentId` était la correction évidente ; elle perdrait
            // le contexte utile, qui est précisément ce qu'un fil mixte transporte : l'UUID
            // rendu par l'orchestrateur est la donnée dont `notificationAgent` a besoin, et
            // c'est un tour `assistant`. On ne coupe donc rien. Ce qu'on retire, c'est la
            // MÉPRISE : sans marque, un agent lit la voix d'un autre comme la sienne — en C7
            // l'orchestrateur a repris le motif de `notificationAgent` (redemander sujet,
            // texte, canal) pour cette seule raison. Coût : ≈ 4 tokens par tour étranger,
            // zéro sur un fil homogène (le cas courant).
            content:
              turn.agentId === context.agentId ? turn.content : FOREIGN_TURN_PREFIX + turn.content,
          } as const)
        : // Un tour `user` n'est jamais préfixé : ce que la personne a dit reste ce qu'elle a
          // dit, quel que soit l'agent qui l'a reçu.
          ({ role: 'user', content: turn.content } as const),
    );

    // Le préambule serveur ouvre la liste. Mastra le route vers `addSystem()` et le place
    // avant tous les messages de modèle, à côté des instructions de l'agent — donc HORS du
    // bloc `<kisso_XXXX_user_input>`, que la DIRECTIVE 3.1 déclare non fiable.
    const preambleMessages = preamble ? [{ role: 'system', content: preamble } as const] : [];

    return [
      ...preambleMessages,
      ...replayed,
      { role: 'user', content: wrappedCurrentInput } as const,
    ];
  }

  /**
   * Purge périodique, en tâche de fond. Le projet n'a aucun cron, et la rétention n'a pas
   * besoin d'être ponctuelle : la déclencher un message sur cent suffit à borner la table.
   */
  private schedulePruneIfDue(): void {
    this.processedMessages += 1;
    if (this.processedMessages % PRUNE_EVERY_N_MESSAGES !== 0) return;

    const repo = this.getConversationRepo();
    if (!repo) return;

    void repo
      .prune(new Date(Date.now() - this.conversationTtlMs))
      .then((removed) => logger.info('Pruned expired conversation turns', { removed }))
      .catch((error) => logger.warn('Conversation prune failed', { error }));
  }

  /* ----------------------------------------------------------------------- *
   * Lecture défensive du résultat d'agent (observabilité)
   * ----------------------------------------------------------------------- */

  /**
   * Ces trois lecteurs sont volontairement tolérants : la forme exacte du résultat varie
   * selon la version de Mastra, et l'observabilité ne doit JAMAIS faire échouer une
   * réponse déjà produite. Un champ absent vaut `null`, jamais une exception.
   */
  private readSteps(response: unknown): number | null {
    const steps = (response as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps.length : null;
  }

  /** ⚠️ `inputTokens` CUMULE toutes les étapes : ne comparer deux mesures qu'à `steps` égal. */
  private readInputTokens(response: unknown): number | null {
    const usage = (response as { usage?: { inputTokens?: unknown } }).usage;
    return typeof usage?.inputTokens === 'number' ? usage.inputTokens : null;
  }

  async handleUrlVerification(body: SlackEventEnvelope): Promise<{ challenge: string }> {
    logger.info('Handling Slack URL verification');
    return { challenge: body.challenge ?? '' };
  }
}
