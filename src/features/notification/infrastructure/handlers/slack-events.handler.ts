import { WebClient } from '@slack/web-api';
import { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import { logger } from '../../../../shared/logger';
import { wrapAgentInput } from '../../../../shared/security/llm-guardrail';

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

export interface SlackEvent {
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
  | { action: 'process'; event: SlackEvent }
  | { action: 'ignore'; reason: SlackIgnoreReason };

export type SlackIgnoreReason =
  | 'not_event_callback'
  | 'no_event'
  | 'unsupported_event_type'
  | 'not_a_dm'
  | 'bot_message'
  | 'duplicate'
  | 'empty_text';

export interface SlackAcceptContext {
  /** En-tête `X-Slack-Retry-Num` (présent uniquement sur les renvois Slack). */
  retryNum?: string | null;
}

export interface SlackEventsHandlerOptions {
  /** Injection d'un WebClient (tests unitaires). */
  slackClient?: WebClient;
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
const SUPPORTED_EVENT_TYPES = new Set(['app_mention', 'message']);

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

  constructor(botToken: string, mastra: Mastra, options: SlackEventsHandlerOptions = {}) {
    this.slack = options.slackClient ?? new WebClient(botToken);
    this.mastra = mastra;
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

  /** Clé de déduplication : `event_id` si présent, sinon `channel:ts`. */
  private dedupKey(envelope: SlackEventEnvelope): string | undefined {
    if (envelope.event_id) return `id:${envelope.event_id}`;
    const { channel, ts } = envelope.event ?? {};
    if (channel && ts) return `ts:${channel}:${ts}`;
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

    if (event.type === 'message' && event.channel_type !== 'im') {
      return { action: 'ignore', reason: 'not_a_dm' };
    }

    // Anti-boucle : les indices synchrones. `user === bot_user_id` est vérifié plus tard
    // (nécessite un appel réseau `auth.test()`).
    if (event.bot_id || event.subtype === 'bot_message' || event.bot_profile) {
      return { action: 'ignore', reason: 'bot_message' };
    }

    // Les autres sous-types (`message_changed`, `channel_join`, `message_deleted`, …)
    // ne sont pas des messages utilisateur adressés au bot.
    if (event.type === 'message' && event.subtype) {
      return { action: 'ignore', reason: 'unsupported_event_type' };
    }

    if (!this.cleanText(event.text)) {
      return { action: 'ignore', reason: 'empty_text' };
    }

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
    return (text ?? '').replace(/<@[A-Z0-9]+>/g, ' ').replace(/\s+/g, ' ').trim();
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

    // Dernière garde anti-boucle : le bot pourrait poster en tant qu'utilisateur.
    const botUserId = await this.getBotUserId();
    if (botUserId && event.user === botUserId) {
      logger.debug('Ignoring own Slack message', { botUserId });
      return;
    }

    await this.handleMessage(event);
  }

  async handleMessage(event: SlackEvent): Promise<void> {
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

      await postMessage({
        channel,
        text: response.text || "Désolé, je n'ai pas pu générer de réponse.",
      });

      logger.info('Slack response sent', { channel, agentId });
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
