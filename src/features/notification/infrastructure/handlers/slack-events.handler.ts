import { WebClient } from '@slack/web-api';
import { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import { logger } from '../../../../shared/logger';
import { wrapAgentInput } from '../../../../shared/security/llm-guardrail';
import { sanitizeAgentOutput } from '../../../../shared/security/agent-output';
import { SlackAdapter } from '../providers/slack.adapter';
import { SlackWorkspaceService } from '../providers/slack-workspace.service';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { type ProfileModalPrefill } from './profile-modal';
// Extraits le 2026-08-17 vers `infrastructure/ui/welcome-blocks.ts` — voir son en-tête.
// Réexportés en fin de fichier : d'autres modules et des tests les importent depuis ici.
import {
  PROFILE_DONE_ACTION_ID,
  buildProfileButtonBlock,
  buildProfileInviteBlocks,
  buildWelcomeBlocks,
  firstWordOf,
  greet,
  restAfterFirstWord,
  COMPLETE_PROFILE_ACTION_ID,
} from '../ui/welcome-blocks';
import {
  UNSUPPORTED_CLAIM_NOTICE,
  detectUnsupportedCompletionClaim,
  detectUnsupportedDeliveryPromise,
  onlyNonDeliveringTools,
  PROMISED_DELIVERY_NOTICE,
  hasActingToolCall,
  readToolCallNames,
} from '../../domain/services/claim-reconciliation';
import {
  EMPTY_IDENTITY,
  FOREIGN_TURN_PREFIX,
  buildContextPreamble,
  sanitizeDisplayName,
  type RequesterIdentity,
} from '../../domain/services/context-preamble';
import {
  GENERIC_FAILURE,
  QUOTA_FAILURE,
  userFacingFailure,
} from '../../../../shared/user-facing-failure';
import { DEFAULT_AGENT_ID, routeToAgent } from '../../domain/services/agent-routing';
import {
  FILE_ATTACHMENT_REPLY,
  FILE_SHARE_SUBTYPE,
  findActingReply,
  findStaticReply,
  isAnsweredWithoutModel,
  replyFor,
} from '../../domain/services/deterministic-replies';
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
import {
  buildSlackRequestContext,
  readExcerptCoverage,
  type SlackAccessLevel,
} from '../../../../shared/slack-request-context';
import { SlackAccessGuard } from '../../../directory/application/services/access-guard';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import {
  PROFILE_CHECK_UNAVAILABLE,
  verifyProfile,
  type ProfileSnapshot,
} from '../../../onboarding/domain/services/profile-completion';
import {
  PROFILE_CHAT_SAVE_FAILED,
  PROFILE_QUESTIONS,
  answersFromRecord,
  captureProfileAnswer,
  collectProfileAnswers,
  nextProfileStep,
  pendingProfileStep,
  profileRetryReply,
  type ProfileAnswers,
  type ProfileStep,
} from '../../../onboarding/domain/services/profile-chat';
import { runOnboarding } from '../../../onboarding/application/services/run-onboarding';
import { startDateFromJoin } from './profile-modal';
import {
  INTERVIEW_QUESTION_DAILY,
  INTERVIEW_QUESTION_STYLE,
  INTERVIEW_SKIPPED_REPLY,
  INTERVIEW_TOO_SHORT_REPLY,
  captureInterviewAnswer,
  pendingInterviewStep,
  skipsInterview,
  type InterviewStep,
} from '../../../onboarding/domain/services/interview-chat';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { WelcomeChannelsService } from '../../../directory/application/services/welcome-channels.service';
import { DrizzleDirectoryRepository } from '../../../directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackMemberSource } from '../../../directory/infrastructure/providers/slack-member-source.adapter';
import { SlackRateLimiter } from '../services/slack-rate-limiter';
import {
  BURST_RULE,
  DAILY_RULE,
  WORKSPACE_TOKEN_RULE,
  readRuleLimit,
} from '../../domain/services/rate-limit-policy';
import { ERASURE_FAILED_REPLY, erasureDoneReply } from '../../../../shared/forget';
import {
  PROFILE_FORM_CHANNEL_REDIRECT,
  PROFILE_FORM_INVITE,
} from '../../../../shared/profile-request';
import {
  MAX_PINNED_FACTS,
  PIN_FAILED_REPLY,
  extractPinnedFact,
  pinnedFactReply,
} from '../../../../shared/pin-fact';
import type { PinnedFactRepository } from '../../../conversation/domain/ports/pinned-fact.repository';
import { DrizzlePinnedFactRepository } from '../../../conversation/infrastructure/repositories/drizzle-pinned-fact.repository';
import { DrizzleRateLimitRepository } from '../repositories/drizzle-rate-limit.repository';
import { writeAuditLog } from '../../../../infrastructure/audit/audit-log';

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
  | 'duplicate_mention'
  /**
   * Événement trop VIEUX pour qu'on y réponde encore — voir `isStale`. Motif DISTINCT de
   * `duplicate` : un doublon a déjà reçu sa réponse, un événement périmé n'en a jamais eu.
   * Les confondre dans les logs rendrait la panne du 22:34 (une réponse tombée 1 h 40 trop
   * tard) indiscernable d'une déduplication qui fonctionne.
   */
  | 'stale_event'
  /**
   * Quota de messages dépassé pour cette personne. Motif DISTINCT de `duplicate` : les deux
   * écartent un événement, mais l'un dit « on l'a déjà traité » et l'autre « on refuse de le
   * traiter ». Les confondre rendrait le journal de production inexploitable au moment précis
   * où l'on cherche pourquoi quelqu'un n'a pas eu de réponse.
   */
  | 'rate_limited';

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
   * Mémoire LONGUE — les faits explicitement épinglés (« souviens-toi que… »).
   *
   * Séparée de `conversationRepository` parce que leurs durées de vie sont opposées : l'une
   * expire en 60 minutes, l'autre ne meurt que sur demande. `null` la DÉSACTIVE.
   */
  pinnedFactRepository?: PinnedFactRepository | null;
  /**
   * Dépôt de l'entretien post-profil — OPTIONNEL, et sans repli paresseux.
   *
   * ⚠️ Pas de repli paresseux vers Drizzle ici — contrairement à `pinnedFactRepo`, qui en a
   * un — et c'est délibéré. Un repli ferait que TOUT handler construit sans cette dépendance
   * toucherait la base depuis les tests unitaires : c'est exactement le piège qui a rendu onze
   * tests d'`accept()` `rate_limited` le jour où `rate_limit_counters` a existé, et
   * `CLAUDE.md` recense déjà QUATRE dépendances à neutraliser pour cette raison. On n'en
   * ajoute pas une cinquième.
   *
   * Absent, l'entretien COLLECTE et répond correctement sans persister : la conversation reste
   * juste, seule la trace manque. C'est la bonne dégradation — l'inverse (échouer faute de
   * dépôt) casserait un accueil pour un défaut de câblage.
   */
  interviewRepository?: OnboardingInterviewRepository | null;
  /**
   * Dépôt employé pour la VÉRIFICATION de « j'ai fini » — optionnel, sans repli paresseux,
   * même contrat que `interviewRepository` ci-dessus et pour la même raison : un repli ferait
   * qu'un handler construit en test toucherait la base.
   *
   * Absent, la phrase écrite n'est pas reconnue et le message part chez l'agent — dégradé,
   * jamais faux. Le bouton « C'est fait », lui, reste servi par la route, qui a son propre
   * dépôt : les deux chemins ne tombent donc jamais ensemble.
   */
  profileRepository?: { findByEmail(email: string): Promise<ProfileSnapshot | null> } | null;
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
  /**
   * Annuaire du workspace — support de la frontière d'autorisation.
   *
   * `null` la DÉSACTIVE (aucun fait connu sur personne, donc aucune restriction) ; c'est
   * l'ancien comportement, celui où tout invité mono-canal déclenchait `sendNotification`.
   */
  directoryRepository?: DirectoryRepository | null;
  /**
   * Invitation de l'arrivant aux canaux publics d'accueil, au `team_join`.
   *
   * `null` ou absent la DÉSACTIVE — c'est le comportement d'avant le 2026-08-13, et celui de
   * tout test qui ne s'intéresse pas aux canaux. Contrairement à l'annuaire et à la
   * déduplication, il n'y a PAS de construction paresseuse par défaut : ce service a besoin de
   * la configuration `ONBOARDING_WELCOME_CHANNELS`, qui vit dans le câblage.
   */
  welcomeChannels?: WelcomeChannelsService | null;
  /** Politique d'accès. Injectée pour les tests ; en production construite paresseusement. */
  accessGuard?: SlackAccessGuard | null;
  /**
   * Limitation de débit. `null` la DÉSACTIVE.
   *
   * ⚠️ Sans elle, une seule rafale consomme les ≈19 messages/jour du workspace entier : le
   * budget Groq se mesure à la JOURNÉE (`TPD: Limit 100000`), pas à la minute.
   */
  rateLimiter?: SlackRateLimiter | null;
  /**
   * Probabilité qu'un message déclenche une purge de rétention. Voir
   * `DEFAULT_PRUNE_PROBABILITY` : le tirage remplace un compteur d'instance, qui ne survivait
   * pas au gel de la fonction serverless. Injectable pour rendre les tests déterministes.
   */
  pruneProbability?: number;

  /**
   * Où part le journal d'AUDIT.
   *
   * ⚠️ Injectable depuis le 2026-08-19, et pour une raison de TEST, pas de production :
   * `writeAuditLog` ouvre `data/kisso.db` par défaut. C'était la DERNIÈRE dépendance non
   * neutralisable des tests de handler — ≈ 250 ms par message, et sous contention (plusieurs
   * fichiers en parallèle sur le même fichier SQLite) des pointes qui franchissent le délai
   * de 5 s de Vitest. Des faux rouges qui ne désignent jamais leur cause.
   *
   * En production, le défaut reste `writeAuditLog` : rien ne change.
   */
  auditSink?: (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;
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

/**
 * Au-delà de cette ancienneté, les faits d'annuaire d'une personne sont rafraîchis depuis Slack
 * — en tâche de fond, jamais sur le chemin de l'ACK.
 *
 * 24 h parce que ce que porte cette ligne ne change qu'à des gestes rares et humains : une
 * désactivation de compte, un passage en invité, un changement d'adresse. Plus court ferait
 * payer un `users.info` par personne et par jour sans rien apprendre ; beaucoup plus long
 * laisserait un ex-salarié conserver son niveau d'accès pendant des semaines.
 */
const DIRECTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Types d'événements Slack que le bot traite. Tout le reste est ignoré. */
const SUPPORTED_EVENT_TYPES = new Set(['app_mention', 'message', 'team_join']);

/**
 * Identifiant fixe de Slackbot : il « rejoint » techniquement chaque workspace.
 *
 * EXPORTÉ depuis le 2026-08-14 : `scripts/invite-profile-completion.mts` doit l'écarter lui
 * aussi. Slack ne le déclare NI `is_bot` NI `deleted` dans `users.list` — vérifié sur la
 * production, la ligne porte `is_bot=0, is_deleted=0` — donc les deux filtres évidents le
 * laissent passer. Le dupliquer en littéral dans le script ferait qu'un seul des deux
 * appelants serait corrigé le jour où il faudrait le changer.
 */
export const SLACKBOT_USER_ID = 'USLACKBOT';

/**
 * Garde-fou de REQUÊTE : nombre de tours chargés avant fenêtrage. Ce n'est pas le plafond
 * de contexte — celui-là se compte en tokens (`selectWindow`). Il évite seulement de tirer
 * un fil de mille messages en mémoire pour n'en garder que six.
 */
const CONVERSATION_QUERY_LIMIT = 40;

/**
 * Probabilité qu'un message déclenche une purge, en tâche de fond.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi une PROBABILITÉ et non plus un compteur — le TTL ne s'appliquait qu'en LECTURE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La forme précédente était « un message sur cent », sur un compteur d'instance
 * (`this.processedMessages`, en mémoire). Ce compteur ne peut pas fonctionner ici, et c'est
 * structurel :
 *
 *  - il **repart à zéro à chaque démarrage à froid**, or Vercel en provoque un en
 *    permanence — une instance gelée est remplacée, pas reprise ;
 *  - le budget Groq borne le trafic à **≈ 19 messages par jour, tous canaux confondus**.
 *
 * Le seuil de 100 n'était donc **jamais atteint en production**. Conséquence : `prune` ne
 * tournait pour ainsi dire pas, et le TTL de 60 minutes n'était appliqué qu'EN LECTURE, par
 * `recentTurns`. Les lignes, elles, restaient sur la Turso **sans borne de rétention réelle**
 * — y compris celles d'un DM où quelqu'un parle de son salaire, d'un arrêt maladie ou d'un
 * litige, ce que le handler documente lui-même comme l'usage normal de ce canal. Le dépôt
 * annonçait une rétention d'une heure et en pratiquait une illimitée.
 *
 * Une probabilité n'a pas d'état, donc elle survit au gel de la fonction. À 0,2 et
 * ≈ 19 messages/jour, la purge tourne ~4 fois par jour : les tours expirés vivent quelques
 * heures de plus que le TTL au lieu de vivre indéfiniment. C'est un DELETE indexé, hors du
 * chemin de réponse (`void`), et le plus souvent sans effet.
 *
 * ⚠️ Ce n'est toujours pas une garantie de rétention — seul un cron en serait une, et ce
 * projet n'en a aucun. C'est la borne la plus honnête qu'on puisse poser sans en introduire.
 */
const DEFAULT_PRUNE_PROBABILITY = 0.2;

/**
 * Âge au-delà duquel un message n'est plus traité. Voir `isStale` pour le relevé de
 * production qui a motivé cette borne — une réponse arrivée 1 h 40 après la question.
 *
 * 10 minutes : deux ordres de grandeur au-dessus d'un run (2 à 21 s, `maxDuration` 60 s) et
 * des rejeux Slack (la minute). Assez haut pour ne jamais écarter un traitement légitimement
 * lent, assez bas pour qu'aucune réponse ne tombe dans une conversation qui a tourné.
 */
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

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

function resolveThreadTarget(
  event: SlackMessageEvent,
  channel: string,
): { isDirectMessage: boolean; threadTs?: string } {
  const isDirectMessage = event.channel_type === 'im' || channel.startsWith('D');
  const isAlreadyThreaded = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

  if (!isDirectMessage) return { isDirectMessage, threadTs: event.thread_ts ?? event.ts };
  return { isDirectMessage, threadTs: isAlreadyThreaded ? event.thread_ts : undefined };
}

/**
 * Les trois refus de rationnement, un par règle.
 *
 * Une table plutôt que trois ternaires imbriqués : le lecteur vient ici pour savoir ce que le
 * bot DIT, et une cascade de conditions rend justement cela illisible. Une règle ajoutée
 * demain sans son texte retombe sur `burst`, le moins engageant des trois.
 */
const RATE_LIMIT_REPLIES: Readonly<Record<string, string>> = {
  workspaceTokens:
    "Le budget d'IA partagé de l'équipe est épuisé pour aujourd'hui. Il repart demain — " +
    'ce n’est pas ton quota à toi, et personne ne peut le relever en attendant.',
  daily:
    "Tu as atteint ta part du budget partagé pour aujourd'hui. Elle repart demain, et " +
    'elle est relevable — c’est un réglage de déploiement.',
  burst: 'Tu m’écris plus vite que je ne sais répondre. Laisse-moi une minute et reformule.',
};

/**
 * Ce qu'un message porte, une fois ses gardes franchies.
 *
 * ⚠️ Construit UNE FOIS par `buildMessageContext` et passé tel quel. Avant le 2026-08-18,
 * `channel`, `threadTs`, `user` et `text` étaient retransmis un par un dans une quinzaine de
 * signatures — chaque nouvelle étape en rajoutait un.
 */
interface MessageContext {
  readonly event: SlackMessageEvent;
  readonly user?: string;
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly isDirectMessage: boolean;
  readonly conversationId: string;
  /**
   * ⚠️ Volontairement NON attendue : la résolution de l'identité se recouvre avec la lecture
   * de la mémoire au lieu de s'y ajouter. Elle ne rejette jamais.
   */
  readonly requesterIdentity: Promise<RequesterIdentity>;
  readonly history: ConversationTurn[];
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
  private pinnedFactRepo: PinnedFactRepository | null | undefined;
  private readonly interviewRepo: OnboardingInterviewRepository | null | undefined;
  private readonly profileRepo:
    { findByEmail(email: string): Promise<ProfileSnapshot | null> } | null | undefined;
  /**
   * Déduplication partagée. `undefined` = pas encore construite, `null` = désactivée : deux
   * états distincts, d'où l'union.
   */
  private dedupRepo: SlackEventDedupRepository | null | undefined;
  private readonly conversationTokenBudget: number;
  private readonly conversationTtlMs: number;
  /** `undefined` = pas encore construit, `null` = désactivé. Deux états distincts. */
  private directoryRepo: DirectoryRepository | null | undefined;
  /** `null` = désactivé. Aucune construction paresseuse : voir l'option du même nom. */
  private readonly welcomeChannels: WelcomeChannelsService | null;
  private guard: SlackAccessGuard | null | undefined;
  private limiter: SlackRateLimiter | null | undefined;
  /**
   * Probabilité de purge par message. Injectable UNIQUEMENT pour rendre les tests
   * déterministes (0 = jamais, 1 = toujours) — en production c'est le défaut qui vaut.
   */
  private readonly pruneProbability: number;
  /**
   * Cache des noms d'affichage Slack, par instance.
   *
   * Un `users.info` par message coûterait un aller-retour réseau sur le chemin de fond de
   * CHAQUE tour, pour une donnée qui ne change qu'exceptionnellement. Une chaîne vide
   * mémorise un échec — et l'échec doit être mis en cache comme le succès, sinon un
   * workspace qui refuse l'annuaire paie l'appel indéfiniment.
   */
  private readonly requesterNames = new LRUCache<string, RequesterIdentity>({
    max: 500,
    ttl: 12 * 60 * 60 * 1000,
    allowStale: false,
  });

  /** Conservé pour construire paresseusement la source d'annuaire (apprentissage au fil de l'eau). */
  private readonly botToken: string;

  /** Voir `auditSink` : injectable pour que les tests ne touchent pas `data/kisso.db`. */
  private readonly audit: (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;

  constructor(botToken: string, mastra: Mastra, options: SlackEventsHandlerOptions = {}) {
    this.botToken = botToken;
    this.slack = options.slackClient ?? new WebClient(botToken);
    this.mastra = mastra;
    this.audit = options.auditSink ?? writeAuditLog;
    this.chatProvider = options.chatProvider ?? new SlackAdapter(botToken);
    this.workspaceProvider = options.workspaceProvider ?? new SlackWorkspaceService(botToken);
    this.inFlightGraceMs = options.inFlightGraceMs ?? DEFAULT_IN_FLIGHT_GRACE_MS;
    this.conversationRepo = options.conversationRepository;
    this.pinnedFactRepo = options.pinnedFactRepository;
    this.interviewRepo = options.interviewRepository;
    this.profileRepo = options.profileRepository;
    this.dedupRepo = options.dedupRepository;
    this.conversationTokenBudget = options.conversationTokenBudget ?? CONVERSATION_TOKEN_BUDGET;
    this.conversationTtlMs = options.conversationTtlMs ?? CONVERSATION_TTL_MS;
    this.directoryRepo = options.directoryRepository;
    this.welcomeChannels = options.welcomeChannels ?? null;
    this.guard = options.accessGuard;
    this.limiter = options.rateLimiter;
    this.pruneProbability = options.pruneProbability ?? DEFAULT_PRUNE_PROBABILITY;
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

  /** Mémoire longue, construite paresseusement — même raison que les trois autres dépôts. */
  private getPinnedFactRepo(): PinnedFactRepository | null {
    if (this.pinnedFactRepo === undefined) {
      this.pinnedFactRepo = new DrizzlePinnedFactRepository();
    }
    return this.pinnedFactRepo;
  }

  /**
   * Délégation à `domain/services/agent-routing.ts`, extrait le 2026-08-17.
   *
   * La méthode est conservée parce que les tests du handler appellent
   * `handler.routeToAgent(...)` depuis l'origine — et parce que c'est bien le handler qui
   * décide de router. Le CALCUL, lui, n'a jamais lu `this` : c'était une fonction pure
   * enfermée dans une classe.
   */
  routeToAgent(text: string, stickyAgentId?: string): string {
    return routeToAgent(text, stickyAgentId);
  }

  /**
   * Résout (et met en cache) l'identifiant utilisateur du bot via `auth.test()`.
   * Attendu sur le workspace Kisso Ind. (`TMLKC4EPP`) : `U0BMBEJTBMJ`.
   * Jamais codé en dur : le token peut changer de bot.
   */
  /**
   * Annuaire, politique d'accès et compteur de débit — tous construits PARESSEUSEMENT, pour la
   * même raison que la mémoire et la déduplication : le handler est instancié au chargement du
   * module, et y ouvrir une connexion Drizzle paierait la latence sur le démarrage à froid,
   * c'est-à-dire précisément là où les 3 secondes d'ACK de Slack sont déjà les plus serrées.
   */
  private getDirectoryRepo(): DirectoryRepository | null {
    if (this.directoryRepo === undefined) {
      this.directoryRepo = new DrizzleDirectoryRepository();
    }
    return this.directoryRepo;
  }

  private getAccessGuard(): SlackAccessGuard | null {
    if (this.guard === undefined) {
      const repo = this.getDirectoryRepo();
      const source = new SlackMemberSource(new SlackWorkspaceService(this.botToken));

      this.guard = repo
        ? new SlackAccessGuard({
            /**
             * APPRENTISSAGE AU FIL DE L'EAU — c'est ce qui rend la frontière opérante SANS
             * aucune synchronisation préalable.
             *
             * Annuaire d'abord (une lecture sur la PRIMARY KEY, gratuite). Personne inconnue :
             * UN `users.info`, une seule fois dans la vie de cette personne, puis la ligne est
             * écrite. Sans ce repli, la politique dirait `unknown_actor` pour tout le monde
             * jusqu'à ce qu'un humain pense à lancer la synchronisation — c'est-à-dire une
             * frontière présente dans le code et inopérante en production, exactement ce
             * qu'était le correctif de la double réponse tant que `slack_event_dedup` manquait.
             *
             * Le résolveur PROJETTE vers `AccessSubject` plutôt que de passer l'annuaire tel
             * quel : ce type est volontairement réduit aux champs qui portent une conséquence
             * d'autorisation (`isAdmin` en est absent). Un champ présent dans une signature de
             * sécurité finit toujours par être lu comme s'il faisait quelque chose.
             */
            resolveSubject: async (slackUserId) => {
              const known = await repo.findBySlackUserId(slackUserId);

              if (known) {
                // ⚠️ PÉREMPTION — sans elle, l'annuaire est un cache ÉCRIT UNE FOIS et jamais
                // relu : une personne dont le compte Slack est désactivé garderait son niveau
                // d'accès indéfiniment, puisque la seule chose qui pourrait le lui retirer
                // (`is_deleted`) n'est jamais rafraîchie. La frontière serait alors correcte
                // le premier jour et fausse tous les suivants — le pire des deux mondes, parce
                // qu'elle continuerait de rassurer.
                //
                // Le rafraîchissement est DÉTACHÉ, et c'est le point : il ne se paie pas sur le
                // chemin des 3 secondes d'ACK. On rend la valeur connue tout de suite, et la
                // ligne s'auto-répare pour le message SUIVANT. Le prix est un message servi sur
                // des faits de la veille ; l'alternative — attendre `users.info` avant chaque
                // décision — mettrait un aller-retour réseau sur le chemin le plus contraint du
                // système, pour une donnée qui change quelques fois par an.
                if (Date.now() - known.syncedAt.getTime() > DIRECTORY_STALE_AFTER_MS) {
                  void source
                    .fetchById(slackUserId)
                    .then((fresh) => (fresh ? repo.upsertFacts(fresh, new Date()) : undefined))
                    .catch((error) =>
                      logger.warn('Directory refresh failed — keeping the known facts', {
                        slackUserId,
                        error,
                      }),
                    );
                }

                return known;
              }

              const facts = await source.fetchById(slackUserId);
              if (!facts) return null;

              // Écriture opportuniste : l'échec ne doit pas coûter la décision, qui est déjà
              // calculable à partir des faits qu'on vient de lire.
              await repo.upsertFacts(facts, new Date()).catch((error) =>
                logger.warn('Could not persist the directory entry learned on the fly', {
                  slackUserId,
                  error,
                }),
              );

              return facts;
            },
          })
        : null;
    }
    return this.guard;
  }

  private getRateLimiter(): SlackRateLimiter | null {
    if (this.limiter === undefined) {
      // ⚠️ Les limites se lisent depuis l'ENVIRONNEMENT, et c'est ce qui rend enfin vraie la
      // phrase du refus (« c'est un réglage de déploiement »). `readRuleLimit` avait été écrit
      // exactement pour ça et n'avait AUCUN site d'appel : le plafond était un littéral figé à
      // la compilation, donc « relever le plafond » exigeait de modifier le code source.
      //
      // La fonction refuse déjà `0` et les négatifs et retombe sur le défaut — une faute de
      // frappe dans une variable Vercel ne peut pas éteindre le bot en silence.
      this.limiter = new SlackRateLimiter({
        repository: new DrizzleRateLimitRepository(),
        rules: [
          { ...BURST_RULE, limit: readRuleLimit(process.env.SLACK_BURST_LIMIT, BURST_RULE.limit) },
          { ...DAILY_RULE, limit: readRuleLimit(process.env.SLACK_DAILY_LIMIT, DAILY_RULE.limit) },
        ],
        workspaceRule: {
          ...WORKSPACE_TOKEN_RULE,
          limit: readRuleLimit(
            process.env.SLACK_WORKSPACE_TOKEN_BUDGET,
            WORKSPACE_TOKEN_RULE.limit,
          ),
        },
      });
    }
    return this.limiter;
  }

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

    // ⚠️ AVANT la prise de clé : un événement périmé ne doit ni être traité, ni consommer
    // une clé de déduplication qu'il faudrait ensuite refermer.
    if (this.isStale(envelope, event)) {
      return { action: 'ignore', reason: 'stale_event' };
    }

    const key = this.dedupKey(envelope);
    if (key && !(await this.claimEvent(key, context.retryNum))) {
      return { action: 'ignore', reason: 'duplicate' };
    }

    // ⚠️ APRÈS la déduplication, jamais avant. Un rejeu Slack n'est pas un nouveau message :
    // le compter consommerait le quota de quelqu'un pour un événement qu'il n'a envoyé qu'une
    // fois — et c'est précisément sur les démarrages à froid, donc quand le bot va déjà mal,
    // que Slack rejoue le plus.
    const limited = await this.checkRateLimit(event);
    if (limited) return limited;

    return { action: 'process', event };
  }

  /**
   * L'événement est-il trop VIEUX pour qu'on y réponde encore ?
   *
   * ════════════════════════════════════════════════════════════════════════════
   * Le défaut mesuré en production — le bot a répondu à une question d'il y a 1 h 40
   * ════════════════════════════════════════════════════════════════════════════
   *
   *     20:54  Karyl  : « tu peux me retrouver le profil de mistourath@kissohq.com ? »
   *     20:54  Mastra : « Je n'ai pas trouvé d'employé avec cette adresse. »
   *     22:31  Mastra : « J'ai atteint mon quota de messages pour aujourd'hui. »
   *     22:33  Karyl  : « bonjour »
   *     22:34  Mastra : « Je vois que Mistourath n'a pas de dossier d'onboarding… »   ← 20:54
   *     22:35  Mastra : « Ton document a été créé et livré sur ce fil Slack. » + un PDF
   *
   * Deux réponses tardives se sont insérées dans une conversation qui avait avancé depuis,
   * dont une qui a livré un DOCUMENT que plus personne n'attendait. Vu de l'utilisatrice,
   * le bot répond à côté — et le « bonjour » qui précède rend la confusion totale.
   *
   * ── La cause : la reprise d'un événement abandonné n'avait qu'un PLANCHER d'âge ──
   * `claimLocally` et `DrizzleSlackEventDedupRepository.claim` reprennent une clé
   * `in-flight` dès que `ageMs >= inFlightGraceMs` (60 s). Aucune borne HAUTE : une entrée
   * de 61 secondes et une de 100 minutes sont traitées à l'identique. Le traitement repart
   * alors ENTIER — nouvel appel de modèle, nouvelle réponse postée — avec le texte de
   * l'événement d'ORIGINE.
   *
   * S'y ajoute une fuite : `markDedupDone`/`releaseDedup` ne sont appelés que depuis
   * `handleEvent()`, donc un événement refusé par la limite de débit reste `in-flight`
   * **indéfiniment** — prêt à être « abandonné » puis repris à la première redélivrance.
   *
   * ── Pourquoi une borne d'ÂGE DE L'ÉVÉNEMENT, et non un plafond sur la reprise ──
   * Parce qu'elle couvre TOUS les chemins d'un seul contrôle : reprise d'un abandon, rejeu
   * Slack, redélivrance tardive, file d'attente. Un plafond sur la seule reprise laisserait
   * les autres ouverts, et ce dépôt a déjà payé les correctifs posés sur un chemin quand le
   * défaut vivait sur plusieurs.
   *
   * ── Pourquoi on ne LIBÈRE PAS la clé sur un refus de débit ──
   * Ce serait le correctif intuitif de la fuite, et il serait faux : la clé libérée, un rejeu
   * Slack arrivant 5 secondes plus tard repasserait pour un message NEUF et **consommerait
   * une seconde unité du quota de la personne pour un message qu'elle n'a envoyé qu'une
   * fois**. C'est précisément ce que `checkRateLimit` documente en exigeant d'être appelé
   * APRÈS la déduplication. La clé bloquée est donc protectrice, et la borne d'âge suffit à
   * la rendre inoffensive.
   *
   * ── Le chiffre ──
   * 10 minutes, contre un run de 2 à 21 secondes (jusqu'à ~60 s de `maxDuration`) et des
   * rejeux Slack qui vivent dans la minute. La marge est de deux ordres de grandeur : elle
   * ne peut pas écarter un traitement légitimement lent, et elle écarte tout ce qui n'a
   * plus de sens conversationnel.
   *
   * ⚠️ **Les messages seulement.** Un `team_join` tardif doit être traité : il déclenche le
   * parcours d'arrivée d'une personne réelle, et le perdre coûte infiniment plus qu'une
   * réponse hors sujet. La latence n'y est pas un problème de pertinence.
   *
   * ⚠️ Jamais silencieux — `warn`, pas `debug` : « le bot ne répond plus » est le symptôme
   * le plus coûteux de ce dépôt, et une garde muette qui l'imiterait serait indiscernable
   * d'une panne.
   */
  private isStale(envelope: SlackEventEnvelope, event: SlackEvent): boolean {
    if (isTeamJoinEvent(event)) return false;

    // `event_time` (secondes) UNIQUEMENT — jamais `event.ts`, et la distinction compte.
    //
    // `ts` est l'IDENTIFIANT d'un message dans son canal ; c'est la matière première de la
    // clé de déduplication, pas une horloge. Rejeux, fixtures et outils de test le tiennent
    // légitimement CONSTANT, et le lire comme une date ferait périmer des événements
    // parfaitement frais. `event_time` est le seul champ dont le sens EST « quand cet
    // événement a eu lieu », et Slack le pose sur tout `event_callback`.
    //
    // Absent ⇒ on laisse passer. Un âge inconnu n'est pas un âge excessif, et le dépôt
    // penche déjà de ce côté partout où il décide sans preuve (`checkTeamId`, la
    // déduplication partagée, le compteur de débit) : une garde qui coupe sur une donnée
    // manquante reproduit le symptôme le plus coûteux de ce projet, le bot muet.
    const emittedAtSeconds = envelope.event_time;
    if (!Number.isFinite(emittedAtSeconds) || (emittedAtSeconds ?? 0) <= 0) return false;

    const ageMs = Date.now() - (emittedAtSeconds as number) * 1000;
    if (ageMs < MAX_EVENT_AGE_MS) return false;

    logger.warn('Dropping a stale Slack event — answering it now would land out of context', {
      ageMs,
      channel: event.channel,
      type: event.type,
    });

    return true;
  }

  /**
   * Compte le message et dit s'il peut être traité.
   *
   * Placé dans `accept()` et non dans `handleMessage()` : c'est le seul endroit qui soit AVANT
   * l'ACK, donc avant que le travail de fond ne soit programmé. Refuser plus tard laisserait
   * déjà partir l'appel LLM — c'est-à-dire la dépense qu'on cherche à borner.
   *
   * NE LÈVE JAMAIS : `SlackRateLimiter` dégrade tout seul vers son compteur local quand le
   * store partagé est indisponible, et une panne du compteur ne doit pas devenir une panne du
   * bot. Ici on n'ajoute qu'une garde de plus, par principe de non-régression.
   */
  /**
   * Ce message sera-t-il traité SANS aucun appel de modèle ?
   *
   * DÉLÉGATION à `deterministic-replies.ts`, qui déclare les huit cas une seule fois. La
   * version précédente les RECOPIAIT ici, en exigeant d'être « le MIROIR EXACT » des
   * court-circuits de `handleMessage` : une liste tenue à la main, dont l'oubli faisait
   * rationner un message gratuit. Elle ne peut plus diverger.
   */
  private isAnsweredWithoutModel(event: SlackEvent): boolean {
    if (isTeamJoinEvent(event)) return false;

    // Sans `botUserId` : le chemin d'ACK n'a pas les 3 secondes d'un `auth.test()`. La
    // mention résiduelle du bot ne change aucun des verdicts — une salutation reste une
    // salutation, une longueur reste une longueur.
    return isAnsweredWithoutModel({
      text: this.cleanText(event.text),
      subtype: event.subtype,
      // ⚠️ Le seul critère non textuel de la table qui entre dans une DÉCISION, et il est
      // disponible ici sans aucune E/S — condition pour qu'il puisse servir sur le chemin des
      // 3 secondes. Sans lui, « c'est fait » écrit en canal serait compté comme traité sans
      // modèle alors qu'il part chez un agent.
      isDirectMessage: event.channel_type === 'im' || (event.channel ?? '').startsWith('D'),
    });
  }

  private async checkRateLimit(event: SlackEvent): Promise<SlackEventDecision | null> {
    const limiter = this.getRateLimiter();
    if (!limiter) return null;

    // Le sujet est la PERSONNE, pas le canal : c'est un budget de messages par humain. Sans
    // auteur identifiable il n'y a personne à débiter, et refuser par défaut couperait les
    // événements systèmes.
    const subject = isTeamJoinEvent(event) ? event.user?.id : event.user;
    if (!subject) return null;

    try {
      const decision = await limiter.check(subject, new Date(), {
        answeredWithoutModel: this.isAnsweredWithoutModel(event),
        // ⚠️ RÉSERVATION, pas consommation. La décision d'abandonner un fil ne se prend qu'en
        // tâche de fond, une fois l'historique lu — bien après ce point. Débiter ici faisait
        // payer le budget quotidien à des messages qui n'atteindront jamais un modèle. Le
        // débit réel vit dans `chargeModelBudget`, juste avant `agent.generate()`.
        reserveOnly: true,
      });
      if (decision.allowed) return null;

      logger.warn('Slack event dropped: rate limit exceeded', {
        slackUserId: subject,
        rule: decision.rule,
        degraded: decision.degraded,
      });

      void this.audit({
        action: 'RATE_LIMITED',
        actorId: subject,
        status: 'denied',
        details: { rule: decision.rule, degraded: decision.degraded },
      });

      // `shouldNotify` n'est vrai qu'au PREMIER refus de la fenêtre. Le dire à chaque message
      // transformerait la protection en son propre spam — et chaque publication est elle-même
      // un appel à l'API Slack.
      if (decision.shouldNotify && !isTeamJoinEvent(event) && event.channel) {
        await this.notifyRateLimited(event.channel, decision.rule);
      }

      return { action: 'ignore', reason: 'rate_limited' };
    } catch (error) {
      // Fail-open BRUYANT, doctrine constante du dépôt : un message de trop est visible et
      // corrigeable, un bot muet ne l'est pas.
      logger.error('Rate limit check failed — letting the event through', { error });
      return null;
    }
  }

  /**
   * Débite le budget MODÈLE du demandeur, une fois qu'il est acquis qu'un modèle sera appelé.
   *
   * Contrepartie de la RÉSERVATION faite dans `accept()`. Sans auteur identifiable il n'y a
   * personne à débiter — même raison que dans `checkRateLimit`.
   *
   * ⚠️ Ne REFUSE pas et ne lève pas : le refus a déjà eu lieu à l'ACK, sur la réservation. Ce
   * point-ci ne fait qu'acter la dépense. Y rejouer un refus ferait renoncer après avoir lu
   * l'historique et résolu l'identité, pour un verdict que l'appelant a déjà obtenu.
   */
  private async chargeModelBudget(slackUserId: string | undefined): Promise<void> {
    if (!slackUserId) return;
    const limiter = this.getRateLimiter();
    if (!limiter) return;

    try {
      await limiter.consumeModelBudget(slackUserId);
    } catch (error) {
      // Même doctrine que le fail-open de `checkRateLimit` : un compteur en panne ne doit
      // jamais priver quelqu'un d'une réponse.
      logger.error('Could not charge the model budget — serving the message anyway', { error });
    }
  }

  private async notifyRateLimited(channel: string, rule: string | null): Promise<void> {
    try {
      await this.slack.chat.postMessage({
        channel,
        // Tutoiement, comme les trois agents : le basculement de registre exact au moment où
        // ça casse donne l'impression de deux interlocuteurs différents. Et on ne nomme pas la
        // règle — l'utilisatrice n'a rien à faire de « BURST_RULE », elle a besoin de savoir
        // quoi faire ensuite.
        // Trois refus DISTINCTS, parce qu'ils appellent trois gestes différents. Il n'y en
        // avait que deux, et le texte « quota » était doublement faux :
        //
        //  - « MON quota » personnalisait une contrainte COLLECTIVE. Le budget est celui du
        //    fournisseur, partagé par toute l'équipe : relever le plafond d'une personne ne
        //    crée aucun token, ça lui permet seulement d'épuiser plus vite la part des autres.
        //  - « demande à un administrateur de relever le plafond » promettait un levier qui
        //    N'EXISTAIT PAS — `readRuleLimit` n'avait aucun site d'appel, la limite était un
        //    littéral figé à la compilation. Et la personne à qui le bot disait ça est
        //    l'administratrice. La phrase n'est rétablie que maintenant que les limites se
        //    lisent réellement depuis l'environnement.
        text: (rule && RATE_LIMIT_REPLIES[rule]) || RATE_LIMIT_REPLIES.burst,
      });
    } catch (error) {
      logger.warn('Could not notify the user about the rate limit', { channel, error });
    }
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

    // ⚠️ `file_share` est LAISSÉ PASSER — correctif du 2026-08-13.
    //
    // Déposer un PDF au bot RH est le geste le plus naturel qui soit, et il arrive avec
    // `subtype: 'file_share'` : il tombait donc dans le rejet générique ci-dessous, sans un
    // mot. Pour la personne, le bot était simplement EN PANNE — le pire des symptômes,
    // parce qu'il ne se distingue pas d'une vraie panne et n'invite à rien.
    //
    // On ne lit toujours AUCUN contenu de fichier (c'est un choix de sécurité, pas une
    // limite technique) : `handleMessage` répond une phrase déterministe, sans appel LLM.
    if (event.type === 'message' && event.subtype && event.subtype !== FILE_SHARE_SUBTYPE) {
      return 'unsupported_event_type';
    }

    // Un partage de fichier porte souvent un texte VIDE : la garde ci-dessous l'écarterait
    // avant que `handleMessage` ait pu répondre. Elle ne s'applique donc qu'aux vrais
    // messages.
    if (event.subtype !== FILE_SHARE_SUBTYPE && !this.cleanText(event.text)) {
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
  /**
   * Purge des compteurs de débit, en tâche de fond.
   *
   * `SlackRateLimiter.prune()` était écrit, testé… et n'avait AUCUN site d'appel :
   * `rate_limit_counters` croissait sans fin, seule des quatre tables à TTL du dépôt à ne
   * jamais être purgée. Même cadence et même tirage que les deux autres.
   */
  private scheduleRateLimitPruneIfDue(): void {
    if (!this.pruneIsDue()) return;

    // `prune()` avale déjà ses propres erreurs et journalise : rien à rattraper ici.
    void this.getRateLimiter()?.prune();
  }

  private scheduleDedupPruneIfDue(): void {
    if (!this.pruneIsDue()) return;

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
    // `botUserId` est réduit à `[A-Z0-9]` — liste BLANCHE, pas noire — avant interpolation :
    // rien de métacaractère ne peut survivre.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const botMention = new RegExp(`<@${(botUserId ?? '').replace(/[^A-Z0-9]/gi, '')}>`, 'g');
    const mentions = botUserId ? botMention : /<@[A-Z0-9]+>/g;

    return (text ?? '').replace(mentions, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * IDENTITÉ du demandeur — nom d'affichage, email, fiche employé. Mise en cache.
   * **Ne rejette jamais.**
   *
   * ## L'annuaire d'abord, Slack ensuite — et cet ordre est le fond du correctif
   *
   * `users.info` sait rendre un nom et une adresse ; il ne sait RIEN de `employees.id`, qui
   * n'existe que chez nous. Or c'est l'identifiant que consomment la moitié des outils
   * (`getTaskList`, `scheduleReminder`, `sendNotification`…). Interroger Slack en premier
   * rendrait donc une identité systématiquement amputée de sa moitié la plus utile, alors
   * qu'une lecture sur la PRIMARY KEY de l'annuaire les rend toutes les deux d'un coup.
   *
   * Le repli sur `users.info` est conservé pour la personne que l'annuaire ne connaît pas
   * encore : sans lui, le préambule perdrait le nom pour tout nouvel arrivant tant que
   * personne n'a lancé la synchronisation. Il ne rend jamais d'`employeeId` — c'est correct,
   * et c'est exactement pourquoi le champ est OMIS plutôt que rendu vide.
   *
   * ## Ce qui est mis en cache
   *
   * Les ÉCHECS comme les succès (identité vide) : un workspace qui refuse `users.info` ne
   * doit pas coûter un aller-retour réseau à chaque message. Le TTL de 12 h borne la
   * péremption — une fiche employé rattachée après coup met au plus une demi-journée à
   * apparaître, ce qui est sans conséquence : le rattachement est une opération d'annuaire,
   * pas un geste de conversation.
   */
  private async resolveRequesterIdentity(
    slackUserId: string | undefined,
  ): Promise<RequesterIdentity> {
    if (!slackUserId) return EMPTY_IDENTITY;

    const cached = this.requesterNames.get(slackUserId);
    if (cached !== undefined) return cached;

    let resolved: RequesterIdentity = EMPTY_IDENTITY;

    try {
      const known = await this.getDirectoryRepo()?.findBySlackUserId(slackUserId);

      if (known) {
        resolved = {
          displayName: sanitizeDisplayName(
            known.realName || [known.firstName, known.lastName].filter(Boolean).join(' '),
          ),
          email: known.email,
          employeeId: known.employeeId,
        };
      }
    } catch (error) {
      // Une panne d'annuaire ne doit pas devenir une panne du bot : on tombe sur Slack.
      logger.debug('Directory lookup failed while resolving the requester identity', {
        slackUserId,
        error,
      });
    }

    if (!resolved.displayName) {
      try {
        const member = await this.workspaceProvider.getUserById(slackUserId);
        resolved = {
          ...resolved,
          displayName: sanitizeDisplayName(
            member?.realName || [member?.firstName, member?.lastName].filter(Boolean).join(' '),
          ),
          // `??` et non `||` : une adresse vide rendue par Slack ne doit pas écraser celle que
          // l'annuaire vient peut-être de fournir.
          email: resolved.email ?? member?.email ?? null,
        };
      } catch (error) {
        logger.debug('Unable to resolve the Slack display name — falling back to the user id', {
          slackUserId,
          error,
        });
      }
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

    // L'instant de l'événement EST la date d'arrivée. Lu UNE SEULE FOIS, avant toute E/S :
    // deux lectures d'horloge donneraient deux dates pour un seul et même fait, et celle qui
    // finirait en base ne serait pas celle du journal.
    const joinedAt = new Date().toISOString();

    try {
      const identity = await this.resolveNewcomer(user);
      logger.info('Welcoming a newcomer', {
        userId: user.id,
        hasEmail: Boolean(identity.email),
      });

      // Les deux gestes qui précèdent le DM sont indépendants l'un de l'autre ET du DM. Chacun
      // avale son échec : ni l'annuaire ni les canaux ne valent de priver quelqu'un de son
      // message de bienvenue. Un arrivant sans canal mais avec son DM peut demander de l'aide ;
      // l'inverse ne le peut pas.
      await this.recordNewcomer(user.id, identity, joinedAt);
      const joinedNames = await this.inviteToWelcomeChannels(user.id);

      await this.chatProvider.sendBlocks(
        user.id,
        greet(identity.firstName ?? ''),
        buildWelcomeBlocks({ ...identity, joinedAt }, joinedNames),
      );
    } catch (error) {
      logger.error('Unable to send the welcome DM', { error, userId: user.id });
    }
  }

  /**
   * Rend l'arrivant résolvable dès la seconde zéro.
   *
   * Sans cela, l'annuaire n'apprend une personne qu'au PREMIER MESSAGE qu'elle envoie — et
   * `findEmployeeByEmail`, qui s'y replie depuis le 2026-08-12, répondait « introuvable » pour
   * quelqu'un que Slack venait pourtant d'annoncer. C'est exactement le symptôme signalé en
   * production (« il ne retrouve que mon profil »), vu depuis son autre extrémité.
   *
   * ⚠️ `teamId` est laissé VIDE : le payload `team_join` ne le porte pas de façon fiable, et
   * `upsertFacts` ne doit jamais écraser un fait connu par une supposition. Une synchronisation
   * ultérieure le renseignera.
   */
  private async recordNewcomer(
    slackUserId: string,
    identity: ProfileModalPrefill,
    joinedAt: string,
  ): Promise<void> {
    const repo = this.getDirectoryRepo();
    if (!repo) return;

    const realName = [identity.firstName, identity.lastName].filter(Boolean).join(' ');

    try {
      await repo.upsertFacts(
        {
          slackUserId,
          teamId: '',
          email: identity.email ?? null,
          realName,
          displayName: realName,
          firstName: identity.firstName ?? null,
          lastName: identity.lastName ?? null,
          // Le poste DÉCLARÉ dans Slack n'est pas lu au `team_join` : il est vide à la seconde
          // zéro, et c'est précisément ce qu'on va demander à la personne.
          title: null,
          isBot: false,
          isAdmin: false,
          isRestricted: false,
          isUltraRestricted: false,
          isDeleted: false,
        },
        new Date(joinedAt),
      );
    } catch (error) {
      logger.error('Unable to record the newcomer in the directory', { error, slackUserId });
    }
  }

  /** Rend les noms des canaux où l'arrivant se trouve. Ne lève JAMAIS. */
  private async inviteToWelcomeChannels(slackUserId: string): Promise<readonly string[]> {
    if (!this.welcomeChannels) return [];

    try {
      const report = await this.welcomeChannels.run(slackUserId);
      return report.joinedNames;
    } catch (error) {
      // Le service déclare ne jamais lever ; on ne le suppose pas pour autant. Une exception
      // qui traverserait ce point emporterait le DM de bienvenue avec elle.
      logger.error('Welcome channel invitations threw', { error, slackUserId });
      return [];
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

  // ─────────────────────────────────────────────────────────────────────────
  // EFFACEMENT DEMANDÉ — un geste RÉEL, jamais une narration
  // ─────────────────────────────────────────────────────────────────────────
  //
  // « oublie ce que je t'ai dit », « supprime tout ce que tu sais de moi » : jusqu'ici ces
  // messages partaient au modèle, qui n'a AUCUN outil d'effacement et ne pouvait donc que
  // le raconter. C'est le défaut central de ce dépôt — « il parle exactement de la même
  // façon quand il a fait le travail et quand il l'a inventé » — appliqué à la seule
  // demande à laquelle une narration ne peut PAS se substituer.
  //
  // ⚠️ La réconciliation FAIT/NARRATION n'aurait rien rattrapé : elle guette une formule
  // d'accompli sans `toolCall`, or il n'existait aucun tool à appeler, donc aucune
  // contradiction à constater. Le seul correctif possible était de rendre le geste réel.
  //
  // Placé APRÈS la détresse et AVANT la frontière d'autorisation, délibérément : effacer
  // ses propres données n'est pas un privilège qu'on accorde au niveau `full`, c'est un
  // droit. Le même raisonnement que pour la détresse — on ne fait pas passer une politique
  // d'accès devant une demande qui ne porte que sur soi.
  private async runErasure(ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
    conversationId: string;
    isDirectMessage: boolean;
  }): Promise<void> {
    const { channel, threadTs, user, conversationId, isDirectMessage } = ctx;
    // En DM, `deriveConversationId` retombe sur le canal `D…` : la conversation EST
    // l'espace privé d'une seule personne, donc tout y est à elle, tours `assistant`
    // compris. Dans un fil de canal, plusieurs humains parlent — effacer le fil entier
    // parce que l'un d'eux le demande supprimerait les messages des autres.
    const scope = isDirectMessage ? { conversationId } : { conversationId, slackUserId: user };

    const repo = this.getConversationRepo();

    // Hors DM sans auteur identifié, la portée serait INDÉTERMINÉE — et une portée
    // indéterminée sur une suppression, c'est la suppression du fil entier. On préfère
    // échouer bruyamment : c'est irréversible, et personne ne l'a demandé.
    if (!repo || (!isDirectMessage && !user)) {
      logger.warn('Erasure requested but the scope could not be established', {
        channel,
        hasRepo: Boolean(repo),
        isDirectMessage,
      });
      await this.slack.chat.postMessage({
        channel,
        text: ERASURE_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    try {
      const removed = await repo.forget(scope);

      // ⚠️ La mémoire LONGUE part avec, et c'est non négociable : elle survit au TTL de
      // 60 minutes par construction. L'oublier ici ferait qu'une personne ayant demandé
      // l'effacement verrait le bot continuer à citer ce qu'elle lui avait dit de
      // retenir — c'est-à-dire le pire cas possible pour ce chemin.
      //
      // L'effacement porte sur le DEMANDEUR, jamais sur la conversation : les faits sont
      // indexés par `slack_user_id`. En DM les deux coïncident ; en canal, on n'efface
      // que les siens, comme pour les tours.
      //
      // Isolé dans son propre `try` : un échec ici ne doit pas faire annoncer un échec
      // total alors que les tours, eux, sont bien partis. On le journalise et on continue
      // — la réponse rendue reste vraie sur ce qu'elle affirme.
      let removedFacts = 0;
      if (user) {
        try {
          removedFacts = (await this.getPinnedFactRepo()?.forget(user)) ?? 0;
        } catch (error) {
          logger.error('Pinned facts could not be erased', { error, channel });
        }
      }

      // Le COMPTE, jamais le contenu : c'est une trace d'exécution, pas une copie de ce
      // qu'on vient précisément de supprimer.
      logger.info('Erasure request honoured — answered without any LLM call', {
        channel,
        isDirectMessage,
        removed,
        removedFacts,
      });
      await this.slack.chat.postMessage({
        channel,
        text: erasureDoneReply(removed + removedFacts),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (error) {
      // ⚠️ Ne JAMAIS retomber sur `erasureDoneReply` ici. Toute la valeur du correctif
      // tient dans le fait que la réponse dit ce qui s'est réellement passé ; annoncer un
      // effacement qui n'a pas eu lieu serait pire que l'absence de fonctionnalité, parce
      // que la personne cesserait de le demander.
      logger.error('Erasure request failed', { error, channel });
      await this.slack.chat.postMessage({
        channel,
        text: ERASURE_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  private async runPinFact(ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
  }): Promise<void> {
    const { text, channel, threadTs, user } = ctx;
    const factToPin = extractPinnedFact(text);
    if (!factToPin) return;
    // Sans auteur identifié, la mémoire longue n'a pas de clé : elle est indexée par
    // `slack_user_id`, pas par conversation. On le dit plutôt que d'écrire une ligne
    // orpheline que personne ne relira jamais.
    const repo = user ? this.getPinnedFactRepo() : null;

    if (!repo) {
      logger.warn('Pin requested but no long-term memory is available', {
        channel,
        hasUser: Boolean(user),
      });
      await this.slack.chat.postMessage({
        channel,
        text: PIN_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    try {
      await repo.pin(
        {
          id: crypto.randomUUID(),
          slackUserId: user!,
          // Le texte est déjà passé par `cleanText`. Il sera RÉÉMIS au modèle à chaque
          // tour, dans le message `system` — même exigence que pour les tours de
          // conversation : on ne persiste jamais du brut.
          fact: factToPin,
          createdAt: new Date(),
        },
        MAX_PINNED_FACTS,
      );

      // La LONGUEUR, jamais le contenu : c'est une donnée personnelle que la personne
      // vient de confier, elle n'a rien à faire dans un journal.
      logger.info('Fact pinned — answered without any LLM call', {
        channel,
        factLength: factToPin.length,
      });

      await this.slack.chat.postMessage({
        channel,
        text: pinnedFactReply(factToPin),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (error) {
      // ⚠️ Ne JAMAIS retomber sur `pinnedFactReply` ici. Promettre de se souvenir sans
      // avoir pu écrire serait exactement le défaut qu'on corrige, sous une autre forme.
      logger.error('Pin request failed', { error, channel });
      await this.slack.chat.postMessage({
        channel,
        text: PIN_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEMANDE DU FORMULAIRE DE PROFIL — réponse déterministe, aucun appel LLM
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Le défaut : `buildWelcomeBlocks` était le SEUL émetteur du bouton, et son seul
  // appelant `handleTeamJoin`. Un salarié DÉJÀ PRÉSENT n'avait donc aucun chemin vers le
  // formulaire — `team_join` ne se déclenche que sur une ARRIVÉE. Mesuré sur la Turso le
  // 2026-08-14 : `employees` = 2 lignes, `slack_directory` = 4 personnes vivantes de plus,
  // toutes non rattachées.
  //
  // ⚠️ La suite de ce commentaire affirmait que « `team_join` ne figure même pas dans les
  // abonnements de l'app Slack, si bien que les arrivants non plus ». C'est FAUX : vérifié
  // dans la console le 2026-08-15, l'événement EST abonné et `handleTeamJoin` s'exécute.
  // Les cinq personnes sans dossier étaient déjà là AVANT l'installation du bot — un retard
  // de rattrapage, pas un chemin manquant. Ce court-circuit sert donc le rattrapage, aux
  // côtés de `npm run profile:invite`, et non les futurs arrivants.
  //
  // Cela reste la cause du guide « générique » (aucun dossier à personnaliser) et de
  // l'échec de `getEmployeeProfile` sur la plupart des gens.
  //
  // Placé APRÈS l'effacement et AVANT la frontière d'autorisation : remplir son propre
  // dossier n'est pas un privilège de niveau `full`. Un invité rétrogradé en `readonly`
  // doit pouvoir se déclarer — c'est même le seul geste qui puisse le faire sortir de
  // cet état.
  private async runProfileForm(ctx: {
    channel: string;
    threadTs?: string;
    user?: string;
    isDirectMessage: boolean;
  }): Promise<void> {
    const { channel, threadTs, user, isDirectMessage } = ctx;
    // ⚠️ DM UNIQUEMENT, et c'est une décision de SÉCURITÉ, pas d'ergonomie.
    //
    // Le pré-remplissage voyage dans le `value` du bouton, figé à la publication. Dans un
    // canal, n'importe quel témoin peut cliquer : il ouvrirait une modale portant les
    // données de QUELQU'UN D'AUTRE et sa soumission écrirait le dossier de cette
    // personne. Le DM d'accueil n'a jamais eu ce problème — il est privé par nature.
    if (!isDirectMessage) {
      logger.info('Profile form requested in a channel — redirected to DM, no LLM call', {
        channel,
      });
      await this.slack.chat.postMessage({
        channel,
        text: PROFILE_FORM_CHANNEL_REDIRECT,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    // Pré-remplissage depuis l'ANNUAIRE, jamais par `users.info` : une lecture Turso
    // contre un aller-retour Slack, pour une information que l'annuaire tient déjà. Son
    // absence n'empêche rien — la modale collectera les quatre champs à la main.
    const known = user ? await this.getDirectoryRepo()?.findBySlackUserId(user) : null;

    await this.chatProvider.sendBlocks(
      channel,
      PROFILE_FORM_INVITE,
      buildProfileInviteBlocks({
        slackUserId: user ?? '',
        firstName: known?.firstName ?? null,
        lastName: known?.lastName ?? null,
        email: known?.email ?? null,
        // Pas de `joinedAt` hors du flux d'arrivée : `startDateFromJoin` retombe alors sur
        // l'instant courant. C'est la seule date honnête ici — l'arrivée réelle de
        // quelqu'un déjà présent depuis des mois n'est connue de personne.
      }),
    );

    logger.info('Profile form posted — answered without any LLM call', {
      channel,
      prefilled: Boolean(known),
    });
  }

  /**
   * Le pipeline LLM : router, encadrer, générer, assainir, publier.
   *
   * ⚠️ Extrait de `handleMessage` le 2026-08-18. C'est sa SECONDE responsabilité — la
   * première étant l'ordonnancement des gardes et des court-circuits, qui n'appellent aucun
   * modèle. Les deux se lisaient d'affilée dans 670 lignes, et rien ne signalait qu'on passait
   * de l'une à l'autre.
   *
   * ⚠️ Ce qui reste chez l'appelant, et qui ne doit PAS descendre ici : `chargeModelBudget`
   * et `startProgress`. Leur position relative est justifiée par un incident — le marqueur est
   * le premier écrit Slack, et poster « Je regarde ça… » pour le remplacer aussitôt par un
   * refus de quota serait la pire des séquences. Un découpage qui les emporterait rendrait cet
   * ordre invisible.
   */
  private async runAgentPipeline(ctx: {
    event: SlackMessageEvent;
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
    conversationId: string;
    isDirectMessage: boolean;
    history: ConversationTurn[];
    requesterIdentity: Promise<RequesterIdentity>;
    accessLevel: SlackAccessLevel | undefined;
    progress: Awaited<ReturnType<typeof startProgress>>;
  }): Promise<void> {
    const {
      event,
      text,
      channel,
      threadTs,
      user,
      conversationId,
      history,
      requesterIdentity,
      accessLevel,
      progress,
    } = ctx;

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
        // ⚠️ Ce texte VOUVOYAIT et renvoyait « vers l'administrateur » — les deux défauts
        // exacts pour lesquels `NEUTRAL_REFUSAL` a été réécrit : le basculement de registre
        // au moment où ça casse donne l'impression de deux interlocuteurs, et la personne à
        // qui le bot disait ça est justement l'administratrice. Il ne nomme plus l'identifiant
        // d'agent non plus : c'est du vocabulaire interne, sans usage pour qui le lit.
        await progress.resolve(
          "Je n'arrive pas à traiter ta demande — c'est un problème de mon côté. Réessaie, et " +
            'si ça recommence, remonte-le.',
        );
        logger.error('Agent introuvable dans le registre Mastra', { agentId });
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
      // Résolue UNE fois : elle alimente désormais deux consommateurs — le préambule (ce que
      // le modèle sait dire) et le `requestContext` (ce sur quoi un tool a le droit de
      // décider). Deux `await` sur la même promesse rendraient la même valeur, mais nommer la
      // valeur dit qu'il s'agit bien de la même identité des deux côtés.
      const identity = await requesterIdentity;

      // Mémoire LONGUE. Lue ici et non plus haut : ce chemin est le seul qui aille jusqu'au
      // modèle, et les sept court-circuits qui précèdent n'en ont aucun usage — la charger
      // avant eux paierait un aller-retour Turso pour chaque « bonjour ».
      //
      // Dégrade en silence, comme la mémoire conversationnelle : sans faits épinglés le bot
      // redevient oublieux, il ne cesse pas de répondre.
      const pinnedFacts = await this.loadPinnedFacts(user);

      // ⚠️ Hissé dans une variable parce qu'il est BIDIRECTIONNEL depuis le 2026-08-18 : les
      // tools de `knowledge` y ÉCRIVENT la couverture des extraits, et cette boucle est
      // relue plus bas. C'est un canal SERVEUR — il ne traverse ni le prompt, ni les schémas,
      // ni le tool-result — donc l'aller comme le retour coûtent zéro token.
      const requestContext = buildSlackRequestContext({
        channel,
        threadTs,
        // Identifiant du RUN pour les gardes d'idempotence des tools. `event.ts` et non
        // `threadTs` : en DM `threadTs` est absent par conception, donc deux messages
        // successifs partageraient la même clé et la garde bloquerait le second document
        // légitimement demandé.
        eventTs: event.ts,
        slackUserId: user,
        // Fiche employé du DEMANDEUR — la seule donnée qui permette à un tool de
        // distinguer « je consulte mon dossier » de « je consulte celui d'un collègue ».
        // Elle était déjà résolue ici et injectée dans le préambule ; elle ne descendait
        // pas jusqu'aux tools, qui n'avaient donc aucun contrôle possible.
        employeeId: identity.employeeId ?? undefined,
        // Coût en tokens : ZÉRO. Le `RequestContext` ne traverse ni le prompt, ni les
        // schémas de tools, ni le tool-result — c'est ce qui permet de faire descendre une
        // décision d'autorisation jusqu'aux tools sans jamais la soumettre au modèle.
        accessLevel,
      });

      const response = await agent.generate(
        this.buildMessages(history, safeInput, {
          agentId,
          slackUserId: user,
          identity,
          pinnedFacts,
        }),
        {
          requestContext,
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
      //
      // ⚠️ La condition porte sur « aucun outil qui AGIT », et non sur « aucun outil ». Le
      // test `length === 0` d'origine ne se déclenchait presque jamais : une lecture
      // (`findEmployeeByEmail`, `getEmployeeProfile`) ouvre presque tout run et suffisait à
      // désarmer la détection pour le tour entier. Lire ne produit rien — une annonce
      // d'accompli que seules des lectures étayent est fausse par construction.
      const toolCalls = readToolCallNames(response);
      const unsupportedClaim =
        toolCalls !== null && !hasActingToolCall(toolCalls)
          ? detectUnsupportedCompletionClaim(safeOutput.text)
          : null;

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

      // ── LA PROMESSE D'AVENIR — le symétrique, ajouté le 2026-08-18 ──────────
      //
      // Ici l'accompli est VRAI et la suite est fausse : « Le rappel a été enregistré. Il
      // sera envoyé à Karyl par email le 20 août à 09 h 00. » `scheduleReminder` a bel et
      // bien tourné, donc le détecteur ci-dessus se tait par conception — la contradiction
      // n'est pas entre la phrase et la TRACE, elle est entre la phrase et le CÂBLAGE : il
      // n'existe ni cron ni poller, et `findPending()` n'a aucun site d'appel.
      //
      // ⚠️ La consigne de prompt a été essayée D'ABORD et mesurée en échec le même jour : la
      // réponse suivante en production a gagné une date et une heure d'envoi précises. Une
      // consigne est probable, le code est garanti.
      //
      // Les deux notes sont MUTUELLEMENT EXCLUSIVES : `onlyNonDeliveringTools` exige au moins
      // une action, `hasActingToolCall` exige qu'il n'y en ait aucune. Deux démentis accolés
      // à la même réponse se contrediraient l'un l'autre.
      const deliveryPromise =
        toolCalls !== null && onlyNonDeliveringTools(toolCalls)
          ? detectUnsupportedDeliveryPromise(safeOutput.text)
          : null;

      if (deliveryPromise) {
        logger.error('Agent promised an automatic delivery that nothing performs', {
          agentId,
          channel,
          conversationId,
          claim: deliveryPromise,
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
      // ⚠️ `progress.resolve` directement, et non plus un passe-plat qui recevait un
      // `{ channel, text }` dont il JETAIT le `channel` : le marqueur de progression connaît
      // déjà son canal, il a été construit avec. Un paramètre ignoré que les appelants
      // remplissent quand même est une fausse indication sur ce que la fonction fait.
      // ── LA COUVERTURE, QUATRIÈME FORME — 2026-08-18 ────────────────────────
      // Relue depuis le `RequestContext`, où les tools de `knowledge` l'ont écrite pendant le
      // run. Les trois formes précédentes passaient toutes par le modèle et ont été mesurées
      // en échec sur le même canal : champ `coverage` ignoré, champ `hint` ignoré, préface
      // lue mais non relayée — et le jour même, une consigne d'agent réécrite pour couvrir
      // l'affirmation NÉGATIVE a échoué elle aussi (« Aucun blocage explicite n'est
      // mentionné », sur 6 messages vus sur 8). Deux agents, deux consignes, deux échecs :
      // une consigne est PROBABLE, le code est GARANTI.
      //
      // ⚠️ Écrite UNIQUEMENT si le résultat a réellement été tronqué
      // (`describeCoverageForHuman` rend `undefined` sinon) : un avertissement systématique
      // deviendrait du bruit, et le bruit s'ignore.
      const excerptCoverage = readExcerptCoverage(requestContext);

      await progress.resolve(
        safeOutput.text +
          (unsupportedClaim ? UNSUPPORTED_CLAIM_NOTICE : '') +
          (deliveryPromise ? PROMISED_DELIVERY_NOTICE : '') +
          (excerptCoverage ? `\n\n${excerptCoverage}` : ''),
      );

      // Ce que le log ne disait pas et qu'il fallait deviner : combien d'étapes le run a
      // coûté, quels outils ont réellement tourné, et combien de tokens d'entrée ont été
      // brûlés. Sans `toolCalls`, « Le PDF a été généré » est indiscernable d'une pure
      // narration du modèle. Coût : zéro token.
      const inputTokens = this.readInputTokens(response);

      logger.info('Slack response sent', {
        channel,
        agentId,
        conversationId,
        redacted: safeOutput.redacted.length,
        durationMs,
        steps: this.readSteps(response),
        inputTokens,
        toolCalls,
        unsupportedClaim,
        deliveryPromise,
      });

      // ────────────────────────────────────────────────────────────────────────
      // LE COÛT RÉEL EST ENFIN COMPTÉ — il était lu, journalisé, et jeté
      // ────────────────────────────────────────────────────────────────────────
      // `inputTokens` existait déjà à cette ligne exacte et n'alimentait AUCUN compteur : il
      // mourait dans les logs. C'est la grandeur qui a réellement cassé la production
      // (`TPD: Limit 100000, Used 98207`), et rien ne la mesurait — les deux règles en place
      // comptaient des MESSAGES, et par PERSONNE.
      //
      // ⚠️ Ici, et pas avant : le coût n'est connu qu'APRÈS l'appel. Le message qui fait
      // franchir le seuil passe donc toujours, et le dépassement est constaté au suivant.
      // C'est la contrepartie assumée du choix de compter la bonne grandeur plutôt qu'une
      // grandeur commode.
      //
      // `void` : on est après la publication de la réponse. Une erreur de comptabilité ne
      // doit rien changer pour la personne qui vient d'être servie.
      void this.getRateLimiter()?.consumeTokens(inputTokens);

      this.schedulePruneIfDue();
      this.scheduleDedupPruneIfDue();
      this.scheduleRateLimitPruneIfDue();
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
        // ⚠️ `textLength`, JAMAIS `text` — symétrique du chemin nominal 200 lignes plus haut,
        // qui explique pourquoi : le DM au bot est le canal privilégié pour parler d'un
        // salaire, d'un arrêt maladie ou d'un litige. Le texte figurait ici en clair, en
        // niveau `error`, et `maskPii` ne le rattrapait pas (`text` n'est pas dans
        // `PII_KEYS`). Le chemin d'erreur est FRÉQUENT — c'est celui qu'emprunte
        // l'épuisement du quota Groq —, donc le message le plus sensible finissait dans les
        // logs au moment précis où le bot allait mal.
        textLength: text.length,
        user,
      });

      // `fail()` ne lève jamais : il est déjà sur le chemin d'erreur, et y remplacer une
      // exception par une autre effacerait la cause d'origine.
      await progress.fail(userFacingFailure(error));
    }
  }

  /**
   * La frontière d'autorisation : évalue, refuse, journalise l'audit.
   *
   * Rend `'denied'` quand elle a déjà répondu à la personne — l'appelant n'a plus qu'à
   * s'arrêter. Sinon rend le niveau, que le pipeline transmet aux tools par le
   * `requestContext`.
   *
   * ⚠️ Elle vient APRÈS les huit court-circuits, et cette position est un choix : détresse,
   * effacement, épinglage et demande de formulaire sont des DROITS, pas des privilèges de
   * niveau `full`. Quelqu'un qui va mal ne doit pas se heurter à une politique d'accès.
   */
  private async enforceAuthorization(ctx: {
    user?: string;
    channel: string;
    threadTs?: string;
    isDirectMessage: boolean;
  }): Promise<SlackAccessLevel | undefined | 'denied'> {
    const { user, channel, threadTs, isDirectMessage } = ctx;
    const accessLevel = await this.evaluateAccess(user);

    if (accessLevel !== 'denied') return accessLevel;

    logger.warn('Slack message refused by the authorization policy', { user, channel });
    void this.audit({
      action: 'AUTHZ_DENIED',
      actorId: user ?? 'unknown',
      status: 'denied',
      details: { channel, isDirectMessage },
    });
    // Muet sur la règle touchée, exactement comme `NEUTRAL_REFUSAL` : nommer ce qui a porté
    // renseignerait un attaquant sur la sonde qui a fonctionné.
    await this.slack.chat.postMessage({
      channel,
      text: "Je ne peux pas traiter cette demande. Rapproche-toi d'une personne de l'équipe.",
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return 'denied';
  }

  /**
   * Tout ce qu'il faut savoir sur un message avant de décider quoi en faire.
   *
   * Rend `null` quand il n'y a rien à faire — message du bot, canal absent, ou fil de canal
   * où le bot n'a jamais parlé. L'appelant s'arrête, sans avoir à savoir pourquoi.
   *
   * ⚠️ L'ORDRE des trois dernières lignes est justifié par un incident et ne doit pas être
   * réarrangé : l'historique est lu AVANT que le marqueur de progression n'existe, parce
   * qu'un fil non engagé est abandonné ici même — poster « Je regarde ça… » pour l'effacer
   * aussitôt laisserait un message orphelin dans le fil.
   */
  private async buildMessageContext(event: SlackMessageEvent): Promise<MessageContext | null> {
    const { user, channel } = event;

    // Garde défensive : `handleMessage` peut être appelé directement.
    if (event.bot_id || event.subtype === 'bot_message') {
      logger.debug('Ignoring bot message', { botId: event.bot_id });
      return null;
    }

    if (!channel) {
      logger.warn('Slack event without channel, skipping', { user });
      return null;
    }

    // La promesse est déjà résolue sur ce chemin (`processEvent` l'a attendue), donc gratuit.
    const botUserId = await this.getBotUserId();
    const text = this.cleanText(event.text, botUserId);

    const { isDirectMessage, threadTs } = resolveThreadTarget(event, channel);

    // Clé du fil. En DM `threadTs` est `undefined` par conception (voir plus haut), donc
    // la conversation EST le canal ; en canal, c'est le thread.
    const conversationId = deriveConversationId({ channel, threadTs });

    // Lancée SANS `await` : la résolution de l'identité se recouvre avec la lecture de la
    // mémoire au lieu de s'y ajouter. Elle ne rejette jamais (cf. `resolveRequesterIdentity`).
    const requesterIdentity = this.resolveRequesterIdentity(user);

    const history = await this.loadHistory(conversationId);

    if (this.shouldAbandonThreadReply(event, isDirectMessage, history, botUserId)) {
      logger.info('Ignoring a channel thread reply: the bot has never spoken in this thread', {
        channel,
        threadTs,
        historyTurns: history.length,
      });
      return null;
    }

    return {
      event,
      user,
      channel,
      text,
      threadTs,
      isDirectMessage,
      conversationId,
      requesterIdentity,
      history,
    };
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const context = await this.buildMessageContext(event);
    if (!context) return;

    const {
      user,
      channel,
      text,
      threadTs,
      isDirectMessage,
      conversationId,
      requesterIdentity,
      history,
    } = context;

    // ─────────────────────────────────────────────────────────────────────────
    // SALUTATION NUE — réponse déterministe, aucun appel LLM
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Mesuré en production le 2026-08-12 : « Bonjour » (7 caractères) a déclenché
    // `["findEmployeeByEmail","getEmployeeProfile","updateOnboardingStatus","getTaskList"]`
    // en 5 étapes et **13 376 tokens** — 13 % du budget Groq quotidien — dont une
    // tentative d'ÉCRITURE non demandée sur le dossier de la personne.
    //
    // Placé APRÈS la garde de fil (on ne répond pas dans un fil où le bot n'a jamais
    // parlé) et AVANT le marqueur de progression : la réponse est instantanée, donc
    // « Je regarde ça, un instant… » n'a aucun sens ici.
    //
    // Les deux tours sont mémorisés comme n'importe quel échange : sans cela, un fil
    // ouvert par une salutation ne serait jamais « engagé » et le message suivant, sans
    // mention, serait abandonné par la garde ci-dessus.
    // ─────────────────────────────────────────────────────────────────────────
    // COURT-CIRCUITS À RÉPONSE FIGÉE — salutation, pièce jointe, forme, détresse
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Les cinq premiers des huit court-circuits partagent exactement la même forme : un
    // prédicat, un texte écrit en dur, zéro token. Ils sont déclarés dans
    // `domain/services/deterministic-replies.ts` — voir son en-tête pour la raison, qui
    // n'est pas cosmétique : `isAnsweredWithoutModel` doit en être le miroir exact, et deux
    // listes tenues à la main divergent au premier ajout, en silence.
    //
    // Les trois derniers AGISSENT (effacer, épingler, publier un formulaire) : leur
    // exécution reste ci-dessous, seul leur prédicat vit dans la table.
    // `messageTs` ne sert qu'à choisir la FORMULATION : la même personne voit des tournures
    // différentes d'un message à l'autre, et un message rejoué donne exactement la même
    // réponse. Voir `shared/reply-variants.ts` — la répétition littérale est ce qui fait
    // « machine », et la corriger ici coûte zéro token.
    const shortCircuitInput = {
      text,
      subtype: event.subtype,
      isDirectMessage,
      messageTs: event.ts,
    };
    const staticReply = findStaticReply(shortCircuitInput);
    const staticText = staticReply ? replyFor(staticReply, shortCircuitInput) : null;

    if (staticReply && staticText) {
      logger.info(`Court-circuit deterministe (${staticReply.name}) — aucun appel de modele`, {
        channel,
        ...(staticReply.logFields?.(shortCircuitInput) ?? {}),
      });

      await this.slack.chat.postMessage({
        channel,
        text: staticText,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });

      // Seule la salutation entre en mémoire : sans elle, un fil ouvert par « bonjour » ne
      // serait jamais « engagé » et `shouldAbandonThreadReply` écarterait le message
      // SUIVANT. Voir `remembersTurn` dans la table.
      //
      // ⚠️ SAUF QUAND UNE QUESTION D'ACCUEIL ATTEND — correctif du 2026-08-19, second volet.
      //
      // Le premier volet a fait céder le pas aux court-circuits AGISSANTS ; le groupe
      // STATIQUE, qui tourne AVANT `maybeAdvanceOnboarding`, n'avait pas été traité. L'état
      // des deux machines EST le dernier tour `assistant` du fil : mémoriser ici l'écrase
      // définitivement, et la question en attente devient invisible.
      //
      // Deux dégâts d'un seul geste, et le second est le pire : le tour `user` — « Salut » —
      // serait apparié par `collectProfileAnswers` à la question en attente, donc enregistré
      // comme PRÉNOM, puis imprimé dans un document au nom de la personne. C'est la faute
      // exacte déjà corrigée pour l'entretien (« oublie ce que je t'ai dit » devenu une
      // description de métier), par l'autre porte.
      //
      // ⚠️ ON NE TOUCHE PAS À L'ORDRE, et surtout pas pour la DÉTRESSE. L'asymétrie commande :
      // un faux positif donne un numéro d'aide à quelqu'un qui parlait de son métier — gênant ;
      // un faux négatif enregistre « je ne vais pas bien » comme un nom de famille et n'aide
      // personne — dangereux. La réponse figée est servie ; c'est la MÉMOIRE qu'on retient,
      // pour que le fil reste exactement où il était.
      if (staticReply.remembersTurn && !hasPendingOnboardingQuestion(history)) {
        await this.rememberTurn({
          conversationId,
          role: 'user',
          content: text,
          agentId: DEFAULT_AGENT_ID,
          slackUserId: user ?? null,
        });
        await this.rememberTurn({
          conversationId,
          role: 'assistant',
          content: staticText,
          agentId: DEFAULT_AGENT_ID,
          slackUserId: null,
        });
      }
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // « J'AI FINI » À L'ÉCRIT — le jumeau du bouton « C'est fait »
    // ─────────────────────────────────────────────────────────────────────────
    //
    // ⚠️ Ce chemin existe parce qu'un TEXTE le promettait. Le guide d'accueil dit « clique
    // sur "C'est fait" — ou écris-moi simplement "j'ai fini" » : sans lui, cette phrase était
    // une promesse creuse, et la personne qui suivait l'instruction écrite voyait son message
    // partir chez un agent qui n'a aucune idée de ce qu'elle vient d'accomplir.
    //
    // Il rend exactement le MÊME verdict que le bouton — `verifyProfile` est partagé, pas
    // réécrit : deux formulations pour la même vérification finiraient par ne plus dire la
    // même chose, et c'est la divergence que ce dépôt vient de corriger deux fois en un jour.
    //
    // ZÉRO token. En DM uniquement, comme le formulaire lui-même : le pré-remplissage est
    // personnel, et la vérification porte sur le dossier de celui qui parle.

    // ─────────────────────────────────────────────────────────────────────────
    // ENTRETIEN CONVERSATIONNEL — « Parlons de toi », sans modale et sans modèle
    // ─────────────────────────────────────────────────────────────────────────
    //
    // ⚠️ La modale a été retirée le 2026-08-19 parce qu'elle NE S'OUVRAIT PAS. Un
    // `trigger_id` expire 3 secondes après le clic, et le démarrage à froid de cette fonction
    // a été mesuré à 4,9 s le 2026-08-18, jusqu'à 16 s après une longue inactivité — c'est-à-
    // dire dans le cas d'un ARRIVANT, qui est par définition le premier à écrire de la
    // journée. Le bouton échouait donc systématiquement, et son échec était invisible : Slack
    // affiche une erreur générique, rien n'atteint les logs de ce dépôt.
    //
    // L'état n'est stocké NULLE PART : il se lit dans le dernier tour `assistant` de
    // `history`, déjà chargé pour la mémoire conversationnelle. Aucune table, aucune lecture
    // de plus sur le chemin des 3 secondes — et ZÉRO token, alors qu'un entretien « piloté par
    // le modèle » coûterait trois allers-retours, soit un sixième du budget quotidien du
    // workspace pour poser deux questions dont le texte est connu d'avance.
    //
    // Placé APRÈS les réponses figées (la détresse et la forme d'un message priment sur tout)
    // et AVANT les court-circuits qui agissent : effacer ses données reste prioritaire sur
    // répondre à une question d'accueil.
    if (
      await this.maybeAdvanceOnboarding({
        history,
        isDirectMessage,
        text,
        channel,
        threadTs,
        conversationId,
        user,
        // ⚠️ Résolu par le handler AVANT tout appel de modèle, et il ne vient JAMAIS de la
        // fenêtre du modèle : c'est la même règle que pour `slackEmployeeId` dans le
        // `requestContext` — on ne décide pas d'une écriture sur une valeur qu'un attaquant
        // peut écrire.
        employeeId: (await requesterIdentity).employeeId,
      })
    ) {
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COURT-CIRCUITS QUI AGISSENT — effacer, épingler, publier le formulaire
    // ─────────────────────────────────────────────────────────────────────────
    //
    // ⚠️ Le prédicat vient de la TABLE, il n'est plus réécrit ici. Jusqu'au 2026-08-18 ces
    // trois cas étaient déclarés dans `deterministic-replies.ts` ET ré-évalués à la main
    // juste en dessous : chaque message payait deux fois ces analyses, et un neuvième
    // court-circuit ajouté à la table serait resté MUET tant que personne n'aurait écrit son
    // `if` ici — exactement la divergence que la table existe pour interdire, réintroduite à
    // mi-chemin de sa propre correction.
    //
    // L'ORDRE reste celui de la table, et il est justifié cas par cas là-bas : effacer prime
    // sur retenir, et les trois passent AVANT la frontière d'autorisation — effacer ses
    // données, corriger ce que le bot sait de soi et remplir son propre dossier sont des
    // droits, pas des privilèges de niveau `full`.
    const acting = findActingReply(shortCircuitInput);

    if (acting) {
      switch (acting.action) {
        case 'erasure':
          return this.runErasure({
            text,
            channel,
            threadTs,
            user,
            conversationId,
            isDirectMessage,
          });
        case 'pin_fact':
          return this.runPinFact({ text, channel, threadTs, user });
        case 'profile_form':
          return this.runProfileForm({ channel, threadTs, user, isDirectMessage });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FRONTIÈRE D'AUTORISATION — l'identité franchit enfin la frontière
    // ─────────────────────────────────────────────────────────────────────────
    // Jusqu'ici `event.user` servait au journal et à l'anti-boucle, puis était jeté : une
    // chaîne `U…` opaque dont le système ne pouvait pas dire si elle désignait la responsable
    // RH ou un invité mono-canal. Tous les outils à effet de bord étaient donc atteignables
    // par n'importe qui — y compris un invité externe, qui pouvait faire partir un email
    // depuis le Gmail de l'entreprise, SPF/DKIM parfaitement alignés.
    //
    // ⚠️ Par défaut le mode est OBSERVATION (`AUTHZ_ENFORCE` absent) : la décision est
    // calculée et journalisée, rien n'est refusé. C'est délibéré — une politique mal
    // configurée bloquerait des gens légitimes, et le symptôme (« le bot ne sait plus rien
    // faire ») ne désignerait pas sa cause. On lit les logs, PUIS on active.
    const accessLevel = await this.enforceAuthorization({
      user,
      channel,
      threadTs,
      isDirectMessage,
    });
    if (accessLevel === 'denied') return;

    // Le canal `D…` est appris ICI et NULLE PART AILLEURS : `conversations.list({types:'im'})`
    // répond `missing_scope` faute du scope `im:read`. Slack nous le livre gratuitement dans
    // `event.channel`, et une fois perdu il l'est définitivement — d'où l'écriture
    // conditionnelle côté repository, qui n'écrase jamais une valeur déjà connue.
    if (isDirectMessage && user) {
      void this.getDirectoryRepo()
        ?.rememberDmChannel(user, channel)
        .catch((error) => logger.debug('Could not record the DM channel', { user, error }));
    }

    // ⚠️ Le TEXTE n'est PAS journalisé, et c'est le même raisonnement que pour `audit_logs`
    // vingt lignes plus bas : le DM au bot est le canal privilégié pour parler d'un salaire,
    // d'un arrêt maladie ou d'un litige. Le recopier en clair en niveau `info` l'expose à tout
    // ce qui lit les logs — plateforme comprise. `maskPii` ne rattrapait rien ici : `text`
    // n'est pas dans `PII_KEYS`.
    //
    // Ce qu'on garde est ce qui sert au diagnostic : qui, où, et la TAILLE — c'est elle qui
    // distingue un message vide d'un pavé, sans en révéler le contenu.
    logger.info('Processing Slack message', { user, channel, textLength: text.length });

    void this.audit({
      action: 'SLACK_MESSAGE',
      actorId: user ?? 'unknown',
      resourceType: 'SlackChannel',
      resourceId: channel,
      // Le TEXTE n'est jamais enregistré : le DM au bot est le canal privilégié pour parler
      // d'un salaire ou d'un litige, et une table consultable n'expire pas comme un log.
      details: { accessLevel: accessLevel ?? 'not_evaluated', isDirectMessage },
    });

    // ⚠️ LE DÉBIT DU BUDGET MODÈLE A LIEU ICI, et pas à l'ACK.
    //
    // Tout ce qui précède peut encore renoncer sans rien coûter : un fil abandonné, une
    // salutation, une pièce jointe, une demande d'effacement… Ces chemins ne doivent pas
    // entamer un quota qui se compte à la JOURNÉE (≈ 19 messages tous canaux confondus).
    // `accept()` n'a fait que RÉSERVER — vérifier que le message passerait — parce qu'à
    // l'ACK on ignore encore s'il sera abandonné : l'historique n'est pas lu.
    //
    // Placé AVANT `startProgress` à dessein : le marqueur est le premier écrit Slack, et
    // poster « Je regarde ça… » pour le remplacer aussitôt par un refus de quota serait la
    // pire des séquences.
    await this.chargeModelBudget(user);

    // Marqueur de progression posté IMMÉDIATEMENT, avant tout appel LLM. Un run prend 2 à
    // 17 s (jusqu'à ~21 s quand le back-off du dernier maillon se déclenche), pendant
    // lesquelles le bot paraissait totalement muet. `startProgress` ne bloque pas : il rend
    // la main sans attendre l'aller-retour Slack, et la réponse finale REMPLACE le marqueur
    // — un seul message dans le fil, jamais deux.
    const progress = await startProgress(this.slack, { channel, threadTs });
    await this.runAgentPipeline({
      event,
      text,
      channel,
      threadTs,
      user,
      conversationId,
      isDirectMessage,
      history,
      requesterIdentity,
      accessLevel,
      progress,
    });
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

    if (!history.some((turn) => turn.role === 'assistant')) return true;

    // ⚠️ « Le bot a déjà parlé ici » ne suffit PAS — relevé par l'audit du 2026-08-13.
    //
    // La garde ci-dessus ouvre le fil, elle ne dit rien de QUI parle. Dans un fil où le bot
    // a répondu une fois, il traitait donc les messages de TOUTES les autres personnes, sans
    // mention, y compris ceux qui ne lui étaient pas adressés. Deux conséquences, la
    // première grave :
    //
    //  1. **Un tiers héritait de la mémoire du fil.** C'est un bot RH : cet historique porte
    //     le profil, les tâches et le parcours d'intégration de QUELQU'UN D'AUTRE. Deux
    //     collègues qui commentent une réponse entre eux se voyaient répondre avec le
    //     dossier de la personne qui avait ouvert le fil.
    //  2. Chaque phrase échangée entre humains consommait un run, sur ≈ 19 messages/jour.
    //
    // On exige donc que l'auteur ait DÉJÀ parlé au bot dans ce fil. `slackUserId` est
    // stocké sur chaque tour `user` par `rememberTurn` — la donnée était là, personne ne la
    // lisait. Un tiers reste libre de s'adresser au bot : il lui suffit de le mentionner,
    // ce que la garde précédente laisse passer. C'est le mandat explicite, et il est le bon
    // critère pour quelqu'un dont on n'a jamais eu de message.
    return !history.some((turn) => turn.role === 'user' && turn.slackUserId === event.user);
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
  /**
   * Le PARCOURS D'ACCUEIL, en un seul point d'entrée.
   *
   * Deux étapes conversationnelles s'y enchaînent, et elles sont ici plutôt que dans
   * `handleMessage` pour deux raisons. La première est prosaïque — chacune ajoutait une
   * branche au tronc commun, qui repassait au-dessus du plafond de complexité que ce dépôt
   * tient à zéro warning. La seconde vaut mieux : ce sont les deux moments d'un même
   * parcours, et les voir côte à côte rend leur ORDRE lisible.
   *
   * ⚠️ Et l'ordre porte un cas réel. « C'est fait » doit être reconnu AVANT l'entretien :
   * quand le dossier est complet, la réponse à cette annonce CONTIENT la première question
   * de l'entretien. Inverser reviendrait à traiter l'annonce comme une réponse à une
   * question qui n'a pas encore été posée.
   */
  private async maybeAdvanceOnboarding(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    employeeId: string | null | undefined;
  }): Promise<boolean> {
    if (await this.maybeCheckProfileDone(input)) return true;
    if (await this.maybeRunProfileStep(input)) return true;
    return await this.maybeRunInterviewStep(input);
  }

  /**
   * La personne est-elle en train de compléter son dossier, et si oui, faire avancer.
   *
   * ⚠️ AVANT l'entretien, et l'ordre n'est pas arbitraire : les deux machines lisent le même
   * endroit — le dernier tour `assistant` du fil — et un dossier se remplit avant qu'on
   * demande à quelqu'un comment il aime travailler. Les questions étant des constantes
   * distinctes, les deux prédicats ne peuvent pas reconnaître le même texte.
   *
   * ⚠️ DM UNIQUEMENT, comme tout ce parcours. En canal, le dernier tour `assistant` peut être
   * une question posée à quelqu'un d'AUTRE, et la réponse d'un témoin s'écrirait dans le
   * dossier de cette personne — la même asymétrie de sécurité que `profile-request.ts`.
   */
  private async maybeRunProfileStep(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<boolean> {
    if (!input.isDirectMessage) return false;

    const step = pendingProfileStep(lastAssistantText(input.history));
    if (!step) return false;

    // Même arbitrage que pour l'entretien : effacer ses données, épingler un fait ou demander
    // le formulaire priment sur une question d'accueil en attente. Sans cela, « oublie ce que
    // je t'ai dit » deviendrait le prénom de la personne.
    if (findActingReply({ text: input.text, isDirectMessage: true })) return false;

    await this.runProfileStep({ ...input, step });
    return true;
  }

  /**
   * Un pas de la complétion de dossier. ZÉRO appel de modèle.
   *
   * Trois issues, et une seule écrit en base :
   *   • réponse inexploitable → on relance la MÊME question, en nommant ce qui cloche ;
   *   • champ suivant manquant → on pose la question suivante ;
   *   • dossier complet → on lance le workflow d'intégration, qui enchaîne sur l'entretien.
   *
   * ⚠️ L'état se reconstitue du FIL, jamais d'une table : `collectProfileAnswers` apparie les
   * questions déjà posées avec les réponses données. Le dossier existant sert de socle — donc
   * quelqu'un à qui il ne manque que le poste ne se voit demander que le poste.
   */
  private async runProfileStep(input: {
    step: ProfileStep;
    history: readonly ConversationTurn[];
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<void> {
    const { step, history, text, channel, user } = input;

    const value = captureProfileAnswer(step, text);
    if (!value) {
      await this.sayAndRemember(input, profileRetryReply(step));
      return;
    }

    const known = await this.knownProfileAnswers(user);
    const answers = { ...known, ...collectProfileAnswers(history), [step]: value };
    const next = nextProfileStep(answers);

    if (next) {
      logger.info(`Dossier en conversation (${step} reçu) — aucun appel de modele`, { channel });
      await this.sayAndRemember(input, PROFILE_QUESTIONS[next]);
      return;
    }

    logger.info('Dossier complet en conversation — lancement du workflow', { channel });
    await this.submitProfile(input, answers as Required<ProfileAnswers>);
  }

  /**
   * Ce que le dossier existant renseigne déjà — le socle de la conversation.
   *
   * ⚠️ La résolution passe par l'ANNUAIRE puis par l'email, jamais par le texte du message :
   * c'est la même règle que pour `slackEmployeeId` dans le `requestContext`. On ne décide pas
   * d'une écriture sur une valeur que la personne peut écrire elle-même.
   */
  private async knownProfileAnswers(user: string | undefined): Promise<ProfileAnswers> {
    if (!user || !this.profileRepo) return {};
    try {
      const member = await this.getDirectoryRepo()?.findBySlackUserId(user);
      const email = member?.email;
      if (!email) return {};
      return answersFromRecord(await this.profileRepo.findByEmail(email));
    } catch (error) {
      // Un socle illisible ne casse rien : on redemande tout, ce qui est plus long mais juste.
      logger.warn('Dossier existant illisible — la conversation repart de zéro', {
        error: String(error),
      });
      return {};
    }
  }

  /**
   * Le dossier est complet : on l'enregistre par le MÊME workflow que la modale.
   *
   * ⚠️ `runOnboarding` est partagé (`onboarding/application/services/`) et n'est pas réécrit
   * ici. Deux écrivains pour un même geste, c'est la configuration où ce dépôt a déjà payé :
   * deux chemins vers le formulaire de profil avaient divergé en un jour, et celui qu'on
   * exerçait le moins était le cassé.
   *
   * ⚠️ La date de début n'est pas demandée. `startDateFromJoin` retombe sur le jour même —
   * une question de plus pour une donnée qu'aucun mécanisme n'exploite serait un tour de
   * dialogue payé pour rien, sur un budget qui se compte à la journée.
   */
  private async submitProfile(
    input: {
      channel: string;
      threadTs: string | undefined;
      conversationId: string;
      user: string | undefined;
    },
    answers: Required<ProfileAnswers>,
  ): Promise<void> {
    try {
      await runOnboarding(
        {
          getWorkflow: (key) => this.mastra.getWorkflow(key as never),
          notify: (text) => this.sayAndRemember(input, text),
          // ⚠️ RELIER D'ABORD, DEMANDER ENSUITE — l'ordre EST le correctif du 2026-08-19.
          // La question de l'entretien invite la personne à répondre ; sa réponse arrive au
          // tour SUIVANT, avec une identité relue de l'annuaire. Poser la question avant
          // d'avoir relié rejouerait le défaut un tour plus tard.
          onRecordReady: async (employeeId) => {
            await this.linkRequesterToRecord(input.user, employeeId);
            await this.sayAndRemember(input, INTERVIEW_QUESTION_DAILY);
          },
        },
        answers,
        startDateFromJoin(undefined, new Date()),
      );
    } catch (error) {
      logger.error('Enregistrement du dossier en conversation impossible', {
        error: String(error),
      });
      await this.sayAndRemember(input, PROFILE_CHAT_SAVE_FAILED);
    }
  }

  /**
   * Rattache la ligne d'annuaire au dossier qui vient d'être créé.
   *
   * ## Le défaut que ceci ferme, et pourquoi il était invisible
   *
   * `slack_directory.employee_id` n'était écrite par AUCUN chemin de production. Son unique
   * écrivain est `linkEmployee` ; son unique appelant est `directory-sync.service.ts`, dont
   * l'unique point d'entrée est le script manuel `scripts/sync-slack-directory.mts` — qui, en
   * dry-run (le défaut), le remplace par un no-op.
   *
   * Or c'est de cette colonne que vient l'`employeeId` du demandeur, par
   * `resolveRequesterIdentity`. Deux conséquences, toutes deux mesurées :
   *
   *   1. `persistInterviewAnswer` sortait en silence, donc l'entretien répondait « Noté. »
   *      puis « j'y mettrai ce que tu viens de me dire » sans rien enregistrer. La personne
   *      demandait son guide et recevait le gabarit générique.
   *   2. `canReadPersonRecord` accorde « son propre dossier, toujours » sur ce même champ :
   *      poser `AUTHZ_ENFORCE` aurait coupé chacun de SON PROPRE dossier.
   *
   * ⚠️ Le test de production du 2026-08-19 n'a rien vu : la ligne d'annuaire de la personne
   * qui testait avait été reliée par une exécution passée du script. La feature fonctionnait
   * exactement pour les gens reliés à la main — c'est-à-dire pour son testeur.
   *
   * ⚠️ ON INVALIDE LE CACHE, et ce n'est pas une précaution de style. `requesterNames` est un
   * LRU de 12 h qui mémorise l'identité COMPLÈTE, `employeeId` inclus. Sans cette ligne, le
   * tour suivant relirait l'entrée périmée — donc `employeeId: null` — et le défaut se
   * rejouerait à l'identique, un tour plus tard, avec la base pourtant correcte.
   *
   * ⚠️ Un échec est journalisé et AVALÉ : la personne vient de faire enregistrer son dossier,
   * lui montrer une erreur après coup lui ferait croire que rien n'a abouti. Le geste de
   * rattrapage est humain (`npm run directory:sync -- --apply`) et le log est ce qui le
   * déclenche.
   */
  private async linkRequesterToRecord(
    slackUserId: string | undefined,
    employeeId: string | undefined,
  ): Promise<void> {
    if (!slackUserId || !employeeId) return;

    try {
      await this.getDirectoryRepo()?.linkEmployee(slackUserId, employeeId);
      this.requesterNames.delete(slackUserId);
      logger.info('Annuaire relié au dossier', { slackUserId, employeeId });
    } catch (error) {
      logger.error('Annuaire NON relié — l’entretien et la frontière d’accès en dépendent', {
        slackUserId,
        employeeId,
        error: String(error),
      });
    }
  }

  /**
   * Poste un texte ET l'inscrit dans la mémoire du fil.
   *
   * ⚠️ LES DEUX SONT INDISSOCIABLES : l'état des deux machines à états EST le dernier tour
   * `assistant`. Une question posée sans être mémorisée est invisible au tour suivant, donc la
   * réponse de la personne part chez un agent — la faute exacte mesurée le 2026-08-19, dont le
   * symptôme trompe puisque la question s'affiche parfaitement.
   */
  private async sayAndRemember(
    input: {
      channel: string;
      threadTs: string | undefined;
      conversationId: string;
      user: string | undefined;
      text?: string;
    },
    reply: string,
  ): Promise<void> {
    await this.slack.chat.postMessage({
      channel: input.channel,
      text: reply,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });

    if (input.text !== undefined) {
      await this.rememberTurn({
        conversationId: input.conversationId,
        role: 'user',
        content: input.text,
        agentId: DEFAULT_AGENT_ID,
        slackUserId: input.user ?? null,
      });
    }
    await this.rememberTurn({
      conversationId: input.conversationId,
      role: 'assistant',
      content: reply,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  }

  /**
   * La personne annonce-t-elle avoir fini, et si oui, vérifier.
   *
   * Rend `true` quand elle a répondu. Extraite de `handleMessage` pour la ramener sous le
   * plafond de complexité — et l'extraction dit quelque chose de juste : la CONDITION
   * d'entrée dans une étape appartient à l'étape, pas au tronc commun du handler.
   *
   * ⚠️ DM UNIQUEMENT, comme le formulaire lui-même. La vérification porte sur le dossier de
   * CELUI QUI PARLE ; en canal, la réponse exposerait à des témoins ce qui manque au dossier
   * de quelqu'un d'autre. Même asymétrie que `profile-request.ts`, où la restriction au DM
   * est de la sécurité et non de l'ergonomie.
   */
  private async maybeCheckProfileDone(input: {
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<boolean> {
    // ⚠️ Le prédicat vient de la TABLE, il n'est pas réécrit ici — même règle que pour les
    // trois autres court-circuits agissants depuis le 2026-08-18. C'est ce qui garantit que
    // `isAnsweredWithoutModel` en soit le miroir exact : une seule déclaration, donc aucune
    // divergence possible entre ce qui est exécuté et ce qui est facturé.
    const acting = findActingReply({ text: input.text, isDirectMessage: input.isDirectMessage });
    if (acting?.action !== 'profile_done') return false;

    await this.runProfileDoneCheck(input);
    return true;
  }

  /**
   * Vérifie le dossier de celui qui dit avoir fini, et lui répond.
   *
   * ⚠️ La résolution se fait par EMAIL — la seule clé que `employees` partage avec l'annuaire
   * Slack, cette table n'ayant aucune colonne d'identifiant Slack. Sans email résolvable, on
   * traite comme « aucun dossier » : c'est exact, on n'a effectivement rien pu constater.
   *
   * ⚠️ Un échec de lecture ne devient JAMAIS « ton dossier est incomplet ». Une base
   * indisponible est notre défaut, pas le sien, et le lui imputer l'enverrait corriger un
   * formulaire qui n'a rien à corriger.
   */
  private async runProfileDoneCheck(input: {
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<void> {
    const { text, channel, threadTs, conversationId, user } = input;

    let reply: string;
    try {
      // L'email vient de l'ANNUAIRE Slack, jamais du texte du message : c'est la même règle
      // que pour `slackEmployeeId` dans le `requestContext` — on ne décide pas d'une lecture
      // de dossier sur une valeur que la personne peut écrire elle-même.
      const member = user ? await this.getDirectoryRepo()?.findBySlackUserId(user) : null;
      const email = member?.email ?? null;
      const record = email && this.profileRepo ? await this.profileRepo.findByEmail(email) : null;
      reply = verifyProfile(record).reply;
    } catch (error) {
      logger.error('Vérification « j’ai fini » impossible — on ne l’impute pas à la personne', {
        error: String(error),
      });
      reply = PROFILE_CHECK_UNAVAILABLE;
    }

    logger.info('« J’ai fini » vérifié — aucun appel de modele', { channel });

    await this.slack.chat.postMessage({
      channel,
      text: reply,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    // ⚠️ Mémorisés tous les deux, et c'est INDISPENSABLE : quand le dossier est complet, la
    // réponse CONTIENT la première question de l'entretien, et l'état de cette machine est
    // précisément le dernier tour `assistant`. Ne pas mémoriser ici ferait perdre le fil au
    // message suivant — la faute exacte corrigée côté route quelques heures plus tôt.
    await this.rememberTurn({
      conversationId,
      role: 'user',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: user ?? null,
    });
    await this.rememberTurn({
      conversationId,
      role: 'assistant',
      content: reply,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  }

  /**
   * L'entretien est-il en cours, et si oui, le faire avancer.
   *
   * Rend `true` quand il a répondu — l'appelant s'arrête là. Extraite de `handleMessage` pour
   * la ramener sous le plafond de complexité (ce dépôt tient son lint à ZÉRO warning), et
   * l'extraction dit aussi quelque chose de juste : la CONDITION d'entrée dans l'entretien
   * appartient à l'entretien, pas au tronc commun du handler.
   *
   * ⚠️ DM UNIQUEMENT. En canal, le dernier tour `assistant` du fil peut être une question
   * d'entretien posée à quelqu'un d'AUTRE : la réponse d'un témoin serait alors capturée comme
   * la sienne. Même asymétrie que `profile-request.ts`, où la restriction au DM est de la
   * SÉCURITÉ et non de l'ergonomie.
   */
  private async maybeRunInterviewStep(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    employeeId: string | null | undefined;
  }): Promise<boolean> {
    if (!input.isDirectMessage) return false;

    const step = pendingInterviewStep(lastAssistantText(input.history));
    if (!step) return false;

    // ⚠️ CORRECTIF DU 2026-08-19 : l'entretien CÈDE le pas aux court-circuits agissants.
    //
    // `captureInterviewAnswer` accepte presque n'importe quel texte — c'est sa nature, on
    // demande à quelqu'un de décrire son métier avec ses mots. Une question d'entretien en
    // attente absorbait donc « oublie ce que je t'ai dit » : l'effacement n'avait pas lieu,
    // ET la phrase était enregistrée comme la description du métier de la personne, champ
    // imprimé dans un document à son nom sous « Ton quotidien ».
    //
    // Le commentaire de `handleMessage` affirmait déjà « effacer ses données reste
    // prioritaire sur répondre à une question d'accueil » — le code disait l'inverse. Ce
    // n'est donc pas un arbitrage nouveau, c'est l'application de celui qui était écrit.
    if (findActingReply({ text: input.text, isDirectMessage: true })) return false;

    await this.runInterviewStep({ ...input, step });
    return true;
  }

  /**
   * Un pas de l'entretien conversationnel. ZÉRO appel de modèle, ZÉRO lecture supplémentaire.
   *
   * ⚠️ Les deux tours sont mémorisés comme n'importe quel échange, et c'est OBLIGATOIRE ici :
   * l'état de la machine EST le dernier tour `assistant`. Ne pas mémoriser la question
   * suivante ferait perdre le fil au message d'après, en silence.
   *
   * ⚠️ CE CHEMIN EST DÉSORMAIS LE SEUL ÉCRIVAIN de `onboarding_interview`, et le commentaire
   * qui figurait ici affirmait l'inverse : « l'écriture vit dans la route d'interactivité,
   * avec `applyInterview` ». C'était vrai jusqu'au 2026-08-19, quand les modales ont été
   * retirées — `view_submission` n'est plus jamais émis par Slack. Le commentaire décrivait
   * donc un partage de responsabilité disparu, à quatre lignes d'un appel à
   * `persistInterviewAnswer` qui le démentait.
   */
  private async runInterviewStep(input: {
    step: InterviewStep;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    employeeId: string | null | undefined;
  }): Promise<void> {
    const { step, text, channel, threadTs, conversationId, user } = input;

    // On reconnaît le renoncement AVANT de juger la réponse trop courte : « non » fait quatre
    // caractères de moins que le seuil, et le traiter comme une réponse ratée relancerait la
    // question à quelqu'un qui vient de dire non. Insister est le meilleur moyen de faire
    // abandonner un questionnaire d'accueil pour de bon.
    const skipped = skipsInterview(text);
    const reply = interviewReplyFor(step, text, skipped);

    logger.info(`Entretien conversationnel (${step}) — aucun appel de modele`, {
      channel,
      skipped,
    });

    await this.slack.chat.postMessage({
      channel,
      text: reply,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    await this.rememberTurn({
      conversationId,
      role: 'user',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: user ?? null,
    });
    await this.rememberTurn({
      conversationId,
      role: 'assistant',
      content: reply,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });

    await this.persistInterviewAnswer(input, skipped);
  }

  /**
   * Persiste la réponse — au mieux, et JAMAIS au prix de la conversation.
   *
   * ⚠️ `save` ÉCRASE (la clé primaire est `employee_id`), donc on relit d'abord pour ne pas
   * effacer la réponse de l'autre question. C'est le prix d'une table à une ligne par employé,
   * et il est payé ici plutôt qu'en dupliquant l'état ailleurs.
   *
   * ⚠️ Un échec est journalisé et AVALÉ. La personne vient d'obtenir une réponse cohérente ;
   * lever ici lui ferait voir « une erreur s'est produite » après un échange qui s'est bien
   * passé, et c'est le contraire de ce qu'on veut apprendre d'un accueil. La trace manque,
   * l'accueil tient — même arbitrage que la mémoire conversationnelle, qui dégrade en silence.
   */
  private async persistInterviewAnswer(
    input: {
      step: InterviewStep;
      text: string;
      employeeId: string | null | undefined;
      user: string | undefined;
    },
    skipped: boolean,
  ): Promise<void> {
    const answer = skipped ? null : captureInterviewAnswer(input.text);
    if (!answer || !this.interviewRepo || !input.user) return;

    // ⚠️ CE CAS ÉTAIT MUET, et c'est ce qui a rendu le défaut invisible pendant qu'un test de
    // production le traversait. Il subsiste après le correctif pour les personnes DÉJÀ
    // présentes, dont le dossier a été créé avant que la liaison n'existe. Le produit ne peut
    // pas le réparer seul — le geste est `npm run directory:sync -- --apply` — mais il doit
    // le DIRE plutôt que de perdre en silence ce que quelqu'un vient d'écrire sur lui-même.
    if (!input.employeeId) {
      logger.error('Réponse d’entretien PERDUE — annuaire non relié au dossier', {
        reason: 'missing_employee_id',
        slackUserId: input.user,
        step: input.step,
      });
      return;
    }

    try {
      const existing = await this.interviewRepo.findByEmployee(input.employeeId);
      const now = new Date();
      await this.interviewRepo.save({
        employeeId: input.employeeId,
        slackUserId: input.user,
        channels: existing?.channels ?? [],
        dailyWork: input.step === 'dailyWork' ? answer : (existing?.dailyWork ?? ''),
        workStyle: input.step === 'workStyle' ? answer : (existing?.workStyle ?? ''),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (error) {
      logger.error('Réponse d’entretien non persistée — la conversation, elle, a abouti', {
        error: String(error),
        step: input.step,
      });
    }
  }

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
  /**
   * Faits épinglés de la personne. Ne lève JAMAIS.
   *
   * Même contrat de dégradation que `loadHistory` : la mémoire longue est un CONFORT, pas
   * une condition de fonctionnement. Une table absente ou une base injoignable rend le bot
   * oublieux, jamais muet — et c'est cette propriété qui a permis de déployer
   * `conversation_turns` sans coordination avec le DDL.
   */
  private async loadPinnedFacts(slackUserId: string | undefined): Promise<readonly string[]> {
    if (!slackUserId) return [];

    const repo = this.getPinnedFactRepo();
    if (!repo) return [];

    try {
      const facts = await repo.list(slackUserId, MAX_PINNED_FACTS);
      return facts.map((entry) => entry.fact);
    } catch (error) {
      logger.error('Long-term memory unavailable — continuing without pinned facts', { error });
      return [];
    }
  }

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
    context: {
      agentId: string;
      slackUserId?: string;
      identity: RequesterIdentity;
      pinnedFacts?: readonly string[];
    },
  ) {
    const window = selectWindow(history, this.conversationTokenBudget);

    // Fenêtrage AVANT construction du préambule : l'avertissement d'attribution ne doit être
    // payé (≈ 35 tokens) que si un tour étranger survit réellement au budget de tokens.
    //
    // ⚠️ `email` et `employeeId` sont transmis TELS QUELS, y compris `null`. C'est
    // `buildContextPreamble` qui décide de les omettre — un champ absent y est silencieux,
    // jamais rendu en gabarit à trous. Les filtrer ici dupliquerait cette décision à deux
    // endroits, et c'est leur ABSENCE de la fenêtre du modèle qui a produit les 38
    // `findEmployeeByEmail` en échec du 2026-08-12.
    const preamble = buildContextPreamble({
      slackUserId: context.slackUserId,
      displayName: context.identity.displayName,
      email: context.identity.email,
      employeeId: context.identity.employeeId,
      pinnedFacts: context.pinnedFacts,
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
   * Purge de rétention, en tâche de fond. Déclenchée par tirage — voir
   * `DEFAULT_PRUNE_PROBABILITY` : un compteur d'instance ne survit pas au gel de la fonction
   * serverless, et ne se déclenchait donc jamais.
   */
  /**
   * Tirage sans état — c'est la propriété qui compte. Un compteur d'instance repart à zéro
   * à chaque démarrage à froid ; une probabilité, non.
   */
  private pruneIsDue(): boolean {
    if (this.pruneProbability <= 0) return false;
    if (this.pruneProbability >= 1) return true;
    // Échantillonnage d'une purge de maintenance : aucune décision de sécurité n'en dépend.
    // Le tirage SANS ÉTAT remplace un compteur en mémoire PAR INSTANCE, remis à zéro à chaque
    // démarrage à froid et dont le seuil de 100 n'était donc jamais atteint à ≈ 19 messages
    // par jour : les lignes restaient sur la Turso sans borne réelle.
    // eslint-disable-next-line sonarjs/pseudo-random
    return Math.random() < this.pruneProbability;
  }

  private schedulePruneIfDue(): void {
    if (!this.pruneIsDue()) return;

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

  /**
   * Décide ce que le demandeur a le droit de déclencher.
   *
   * Rend `undefined` quand la question ne se pose pas (pas d'auteur, annuaire désactivé) : ce
   * n'est PAS une autorisation, c'est une non-évaluation — et `canPerformSideEffects` la traite
   * comme le chemin historique. Confondre les deux ferait qu'une panne d'annuaire ouvrirait ou
   * fermerait le produit selon l'humeur du code appelant.
   *
   * NE LÈVE JAMAIS : `SlackAccessGuard.evaluate` avale déjà ses propres échecs, et un annuaire
   * indisponible rend `unknown_actor`, donc `readonly` — la réponse monotone restrictive.
   */
  private async evaluateAccess(user: string | undefined): Promise<SlackAccessLevel | undefined> {
    if (!user) return undefined;

    const guard = this.getAccessGuard();
    if (!guard) return undefined;

    try {
      const evaluation = await guard.evaluate(user);
      return evaluation.effective;
    } catch (error) {
      logger.error('Access evaluation failed — falling back to no evaluation', { user, error });
      return undefined;
    }
  }

  async handleUrlVerification(body: SlackEventEnvelope): Promise<{ challenge: string }> {
    logger.info('Handling Slack URL verification');
    return { challenge: body.challenge ?? '' };
  }
}

// Réexports de compatibilité : `slack-interactions.route.ts` et trois tests importent
// ces symboles depuis ce module depuis l'origine. Les faire pointer ailleurs serait
// une modification de plus dans un même commit, sans rien apporter.
// Réexport : deux tests importent `FILE_ATTACHMENT_REPLY` depuis ce module.
export { FILE_ATTACHMENT_REPLY };

// Réexports de la politique d'échec — le test du handler les importe depuis ici.
export { GENERIC_FAILURE, QUOTA_FAILURE, userFacingFailure };

// Réexports du préambule d'identité — quatre tests les importent depuis ici.
export { FOREIGN_TURN_PREFIX, buildContextPreamble, sanitizeDisplayName };

// Réexports de la réconciliation FAIT/NARRATION — trois tests les importent depuis ici.
export { UNSUPPORTED_CLAIM_NOTICE, detectUnsupportedCompletionClaim, readToolCallNames };

export {
  PROFILE_DONE_ACTION_ID,
  buildProfileButtonBlock,
  buildProfileInviteBlocks,
  buildWelcomeBlocks,
  COMPLETE_PROFILE_ACTION_ID,
};

/**
 * Texte du dernier tour `assistant` du fil, ou `undefined`.
 *
 * C'est le SUPPORT D'ÉTAT de l'entretien conversationnel : on y reconnaît la question que le
 * bot vient de poser. Fonction libre et non méthode — elle ne lit pas `this`, et la déclarer
 * ici la rend éprouvable sans construire un handler entier (ce qui, dans ce dépôt, exige de
 * neutraliser quatre dépendances qui touchent la base).
 */
/**
 * Une question du parcours d'accueil attend-elle une réponse dans ce fil ?
 *
 * ⚠️ Dérivé des DEUX machines à états, jamais d'une liste recopiée : ajouter une question à
 * `profile-chat` ou à `interview-chat` suffit à la couvrir ici. Une troisième copie des
 * marqueurs serait la configuration où ce dépôt a déjà payé — deux bords corrects, aucun
 * câblage entre les deux.
 */
export function hasPendingOnboardingQuestion(history: readonly ConversationTurn[]): boolean {
  const last = lastAssistantText(history);
  return pendingProfileStep(last) !== null || pendingInterviewStep(last) !== null;
}

export function lastAssistantText(history: readonly ConversationTurn[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    if (turn.role === 'assistant') return turn.content;
  }
  return undefined;
}

/**
 * Ce qu'on répond à un pas d'entretien. PURE, et hors de la classe à dessein : elle ne lit
 * pas `this`, elle s'éprouve sans construire un handler (ce qui, dans ce dépôt, exige de
 * neutraliser quatre dépendances qui touchent la base), et l'extraire ramène `runInterviewStep`
 * sous le plafond de complexité que ce dépôt tient à zéro warning.
 *
 * ⚠️ Le renoncement est jugé AVANT la longueur : « non » fait moins que le seuil, et le
 * traiter comme une réponse ratée relancerait la question à quelqu'un qui vient de dire non.
 */
export function interviewReplyFor(step: InterviewStep, text: string, skipped: boolean): string {
  if (skipped) return INTERVIEW_SKIPPED_REPLY;

  const answer = captureInterviewAnswer(text);
  if (!answer) return INTERVIEW_TOO_SHORT_REPLY;
  if (step === 'dailyWork') return INTERVIEW_QUESTION_STYLE;
  return interviewDoneReply(answer);
}

/**
 * Fin de l'entretien.
 *
 * ⚠️ Elle ne PROMET rien. Le texte ne dit ni « je t'ai ajouté aux canaux » ni « ton guide
 * arrive » : ce chemin ne fait ni l'un ni l'autre. C'est la règle la plus constante de ce
 * dépôt — l'email de bienvenue a perdu « vous recevrez prochainement les accès », et
 * `scheduleReminder` a cessé de dire « planifié ». Ce qui est vrai ici, c'est qu'on a écouté.
 */
export function interviewDoneReply(workStyle: string): string {
  const echo = workStyle.length > 60 ? `${workStyle.slice(0, 60)}…` : workStyle;
  return (
    `Compris — ${echo}. C’est tout ce dont j’avais besoin. Demande-moi ton guide d’accueil ` +
    'quand tu veux, j’y mettrai ce que tu viens de me dire.'
  );
}
