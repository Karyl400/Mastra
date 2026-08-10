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

/**
 * Handler des événements Slack (Events API).
 *
 * Le découpage est volontaire :
 *  - `accept()` est SYNCHRONE : filtrage de type, garde anti-boucle bon marché et
 *    déduplication. Il doit tourner AVANT l'ACK HTTP (< 3 s imposées par Slack).
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

  constructor(botToken: string, mastra: Mastra, options: SlackEventsHandlerOptions = {}) {
    this.slack = options.slackClient ?? new WebClient(botToken);
    this.mastra = mastra;
    this.chatProvider = options.chatProvider ?? new SlackAdapter(botToken);
    this.workspaceProvider = options.workspaceProvider ?? new SlackWorkspaceService(botToken);
    this.inFlightGraceMs = options.inFlightGraceMs ?? DEFAULT_IN_FLIGHT_GRACE_MS;
    this.seenEvents = new LRUCache<string, DedupEntry>({
      max: options.dedupMax ?? 1000,
      ttl: options.dedupTtlMs ?? 10 * 60 * 1000,
    });
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
    const pattern = new RegExp(`(?<![\\p{L}])${escaped}`, 'u');
    return pattern.test(lowerText);
  }

  /**
   * Routage mot-clé → agent. Les mots-clés sont contractuels (documentés dans CLAUDE.md),
   * ne pas les modifier sans mettre à jour la doc.
   */
  routeToAgent(text: string): string {
    const lowerText = (text ?? '').toLowerCase();
    const matchesAny = (keywords: string[]): boolean =>
      keywords.some((keyword) => this.matchesKeyword(lowerText, keyword));

    // Mots-clés pour le questionnaire engine
    if (matchesAny(['questionnaire', 'évaluation', 'quiz', 'test'])) {
      return 'questionnaireEngine';
    }

    // Mots-clés pour le notification agent
    if (matchesAny(['notification', 'rappel', 'email', 'message'])) {
      return 'notificationAgent';
    }

    // Par défaut, onboarding orchestrator
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
  accept(envelope: SlackEventEnvelope, context: SlackAcceptContext = {}): SlackEventDecision {
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
    if (key) {
      const existing = this.seenEvents.get(key);
      if (existing) {
        const ageMs = Date.now() - existing.startedAt;
        // Une tentative encore `in-flight` mais plus vieille que la durée de vie maximale
        // d'une invocation ne peut plus être vivante : la fonction a été gelée ou tuée.
        // On rejoue plutôt que de perdre l'événement.
        const abandoned = existing.status === 'in-flight' && ageMs >= this.inFlightGraceMs;

        if (!abandoned) {
          logger.info('Dropping duplicate Slack event', {
            key,
            status: existing.status,
            ageMs,
            retryNum: context.retryNum ?? undefined,
          });
          return { action: 'ignore', reason: 'duplicate' };
        }

        logger.warn('Reprocessing abandoned Slack event', {
          key,
          ageMs,
          retryNum: context.retryNum ?? undefined,
        });
      }
      this.seenEvents.set(key, { status: 'in-flight', startedAt: Date.now() });
    }

    return { action: 'process', event };
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
    if (event.type === 'message' && event.channel_type !== 'im') {
      return 'not_a_dm';
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

  /** Le traitement est allé au bout : tout rejeu ultérieur doit être ignoré. */
  private markDedupDone(key: string | undefined): void {
    if (!key) return;
    this.seenEvents.set(key, { status: 'done', startedAt: Date.now() });
  }

  /**
   * Le traitement a échoué de façon inattendue : on libère la clé pour qu'un rejeu Slack
   * puisse repartir immédiatement au lieu d'être avalé par la déduplication.
   */
  private releaseDedup(key: string | undefined): void {
    if (!key) return;
    this.seenEvents.delete(key);
  }

  /** Retire les mentions (`<@U123456>`) et normalise les espaces. */
  private cleanText(text: string | undefined): string {
    return (text ?? '')
      .replace(/<@[A-Z0-9]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
      this.markDedupDone(key);
    } catch (error) {
      // Échec inattendu : la clé est libérée pour que Slack puisse rejouer.
      this.releaseDedup(key);
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
    const { user, channel, ts, thread_ts } = event;
    const text = this.cleanText(event.text);

    // Garde défensive : `handleMessage` peut être appelé directement.
    if (event.bot_id || event.subtype === 'bot_message') {
      logger.debug('Ignoring bot message', { botId: event.bot_id });
      return;
    }

    if (!channel) {
      logger.warn('Slack event without channel, skipping', { user });
      return;
    }

    // En canal, on threade systématiquement (thread existant, sinon on en ouvre un sur ce
    // message). En DM, threader enfouit la réponse hors de la conversation principale — le
    // bot a semblé silencieux pendant des heures en production pour cette raison exacte. On
    // ne threade donc un DM QUE si le message d'origine faisait DÉJÀ partie d'un thread
    // (`thread_ts` présent et différent de `ts`, sinon `thread_ts` == `ts` == la racine du
    // message courant, pas un vrai thread existant).
    const isDirectMessage = event.channel_type === 'im' || channel.startsWith('D');
    const isAlreadyThreaded = Boolean(thread_ts) && thread_ts !== ts;
    let threadTs: string | undefined;
    if (isDirectMessage) {
      threadTs = isAlreadyThreaded ? thread_ts : undefined;
    } else {
      threadTs = thread_ts ?? ts;
    }

    const postMessage = (payload: { channel: string; text: string }) =>
      this.slack.chat.postMessage(threadTs ? { ...payload, thread_ts: threadTs } : payload);

    logger.info('Processing Slack message', { user, channel, text });

    try {
      const agentId = this.routeToAgent(text);
      logger.info('Routing to agent', { agentId, text });

      const agent = this.mastra.getAgent(agentId);
      if (!agent) {
        logger.error('Agent not found', { agentId });
        await postMessage({
          channel,
          text: `Agent ${agentId} non disponible. Veuillez contacter l'administrateur.`,
        });
        return;
      }

      // Le texte Slack est une entrée UTILISATEUR non fiable : on l'encadre (délimiteurs,
      // détection d'injection, neutralisation Unicode) avant de le transmettre au LLM.
      const safeInput = wrapAgentInput(text);
      const response = await agent.generate(safeInput);

      // Point de passage UNIQUE de toute réponse d'agent vers Slack. C'est ici,
      // et nulle part ailleurs, qu'on garantit qu'aucun marqueur interne ne
      // franchit la frontière et que le style est bien du mrkdwn Slack.
      // Les instructions et le prompt système n'y suffisent pas : la campagne du
      // 2026-08-10 a vu passer le délimiteur `kisso_XXXX`, le marqueur
      // `[SECURITY_BLOCK]` et du markdown GitHub, tous explicitement proscrits.
      const safeOutput = sanitizeAgentOutput(response.text);

      if (safeOutput.redacted.length > 0) {
        // Niveau `error` volontaire : une fuite de marqueur signifie que le
        // modèle a été amené à parler de son propre garde-fou. C'est la ligne à
        // chercher dans les logs après une tentative d'extraction de prompt.
        logger.error('Agent output carried internal markers — response replaced', {
          agentId,
          channel,
          markers: safeOutput.redacted,
        });
      }

      await postMessage({ channel, text: safeOutput.text });

      logger.info('Slack response sent', {
        channel,
        agentId,
        redacted: safeOutput.redacted.length,
      });
    } catch (error) {
      logger.error('Error processing Slack message', { error, text, user });

      try {
        await postMessage({
          channel,
          text: "Désolé, une erreur s'est produite lors du traitement de votre message.",
        });
      } catch (postError) {
        logger.error('Unable to post Slack error message', { error: postError, channel });
      }
    }
  }

  async handleUrlVerification(body: SlackEventEnvelope): Promise<{ challenge: string }> {
    logger.info('Handling Slack URL verification');
    return { challenge: body.challenge ?? '' };
  }
}
