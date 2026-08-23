import { vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
} from '../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import type { DirectoryMember } from '../../src/features/directory/domain/entities/directory-member';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE HANDLER SLACK, CONSTRUIT UNE SEULE FOIS POUR TOUS LES TESTS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Dix-huit fichiers construisaient un `SlackEventsHandler` à la main, chacun avec sa propre
 * `makeHandler()` et sa propre liste de doublures, sans aucun import croisé. Ce n'est pas un
 * problème d'esthétique : **une dépendance oubliée ne produit pas un échec, elle produit une
 * LENTEUR**, et cette lenteur ne désigne jamais sa cause.
 *
 * ⚠️ **CE QUE COÛTE CHAQUE OUBLI, MESURÉ** :
 *
 *   • `directoryRepository` absent — `getDirectoryRepo()` fabrique un `DrizzleDirectoryRepository`
 *     AWAITÉ sur le chemin nominal : ≈ 250 ms de SQLite par message, 2 s au premier. Sur ce
 *     dépôt, `data/kisso.db` pèse 6,7 Mo — ce n'est pas une base vide.
 *   • `accessGuard` absent — la frontière construit un `SlackMemberSource` qui appelle
 *     RÉELLEMENT `users.info` avec le jeton de test : ≈ 3 s, back-off du client compris.
 *   • `workspaceProvider` absent — `resolveRequesterIdentity` est AWAITÉ avant les
 *     court-circuits agissants, donc un `users.info` part vers slack.com : 0,7 à 1,7 s PAR
 *     TEST, le cache d'identité étant un LRU par instance et chaque test reconstruisant le
 *     handler.
 *   • `auditSink` absent — `writeAuditLog` ouvre `data/kisso.db` : ≈ 250 ms par message, avec
 *     des pointes sous contention.
 *   • `rateLimiter` absent — `getRateLimiter()` fabrique un `DrizzleRateLimitRepository` qui
 *     écrit dans la VRAIE base : compteurs partagés entre tests ET persistés d'un run à
 *     l'autre. La suite ne passait que parce que la table `rate_limit_counters` était ABSENTE
 *     de `data/kisso.db` ; le jour où elle est appliquée (elle l'est en production), onze
 *     tests d'`accept()` basculent en `rate_limited`. **Un test vert par absence de table
 *     n'est pas un test vert.**
 *   • `conversationRepository`, `pinnedFactRepository`, `dedupRepository` absents — trois
 *     dépôts Drizzle de plus, donc trois connexions base dans un test unitaire.
 *
 * Des tests à quelques centaines de millisecondes du délai de 5 s de Vitest basculent en rouge
 * dès que la machine travaille : la suite a échoué **deux fois sur neuf exécutions** le
 * 2026-08-19 sans qu'aucun comportement ne soit cassé.
 *
 * ⚠️ **DEUX PIÈGES QUE CETTE FABRIQUE FERME, ET QU'UN `null` ROUVRIRAIT** :
 *
 *   1. **`directoryRepository: null` est PIRE que l'absence.** `resolveRequesterIdentity` fait
 *      `this.getDirectoryRepo()?.findBySlackUserId(...)` : sur `null`, l'optional chaining
 *      saute la lecture, `resolved.displayName` reste vide, et la garde `if
 *      (!resolved.displayName)` retombe sur le `users.info` réseau qu'on croyait éviter. Il
 *      faut une doublure qui **RÉPOND**, pas un trou.
 *   2. **`accessGuard: null` retire `slackAccessLevel` du `requestContext`**, que plusieurs
 *      tests vérifient. C'est le défaut par défaut le plus vicieux : il rendrait ces tests
 *      verts sur une capacité éteinte. La valeur par défaut ici est `null` — c'est ce que la
 *      grande majorité des fichiers passaient — et les fichiers qui LISENT le niveau d'accès
 *      passent une doublure `{ evaluate }` explicite.
 *   3. **Une doublure de `workspaceProvider` doit poser `realName` OU `firstName`+`lastName`.**
 *      `resolveRequesterIdentity` lit `member?.realName || [firstName, lastName]…` et **jamais
 *      `displayName`** : une doublure qui ne pose que `displayName` laisse la garde tirer et
 *      un vrai appel réseau partir. `makeWorkspaceDouble` ne propose donc que les champs lus.
 *
 * ⚠️ **CETTE FABRIQUE NE DÉCIDE RIEN.** Elle neutralise, et rien d'autre : tout ce qu'un test
 * assert — dépôts, agent, horloge — se passe en surcharge et l'emporte. Un défaut qui
 * changerait un comportement se lirait comme une divergence entre deux fichiers, ce que la
 * migration a précisément servi à éliminer.
 *
 * ⚠️ **LA LISTE N'EST PAS RECOPIÉE : elle est VÉRIFIÉE.**
 * `tests/unit/quality/handler-test-harness.test.ts` DÉRIVE du source du handler la liste des
 * options dont l'absence fabrique une vraie dépendance, et exige que cette fabrique en
 * renseigne chacune. Une neuvième dépendance ajoutée demain fait rougir ce test sans que
 * personne ait à y penser — c'est toute la différence avec une liste écrite à la main, qui se
 * désynchronise au premier ajout.
 */

/** Ce que les tests inspectent réellement du client Slack : deux méthodes de `chat`. */
export interface SlackMock {
  chat: { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  auth: { test: ReturnType<typeof vi.fn> };
}

/**
 * Le client Slack des tests.
 *
 * `chat.update` est présent parce que la réponse finale REMPLACE le marqueur de progression :
 * sans lui, `resolve()` retombe sur un `postMessage` et le texte final se lit à un autre
 * endroit. Un fichier qui veut mesurer ce repli passe son propre client.
 */
export function makeSlackMock(options: { botUserId?: string; postTs?: string } = {}): SlackMock {
  const ts = options.postTs ?? '1700000000.000900';
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: {
      test: vi.fn().mockResolvedValue({ ok: true, user_id: options.botUserId ?? 'U0BMBEJTBMJ' }),
    },
  };
}

type DirectoryDouble = NonNullable<SlackEventsHandlerOptions['directoryRepository']>;

/**
 * Un annuaire qui RÉPOND — voir le piège 1 en tête de fichier.
 *
 * Les neuf méthodes du port sont présentes, y compris celles qu'un test donné n'appelle pas :
 * une doublure partielle ne tombe pas en panne au moment où on l'appelle, elle tombe en panne
 * au moment où quelqu'un ajoute un appel, c'est-à-dire loin du test qu'il vient d'écrire.
 */
export function makeDirectoryDouble(row: Partial<DirectoryMember> | null = null): DirectoryDouble {
  return {
    findBySlackUserId: vi.fn(async () => row),
    findByEmail: vi.fn(async () => null),
    findByName: vi.fn(async () => []),
    upsertFacts: vi.fn(async () => undefined),
    rememberDmChannel: vi.fn(async () => undefined),
    hasManager: vi.fn(async () => false),
    findManagers: vi.fn(async () => []),
    linkEmployee: vi.fn(async () => 1),
    findAll: vi.fn(async () => []),
  } as unknown as DirectoryDouble;
}

/**
 * Le fournisseur d'espace de travail — voir le piège 3 en tête de fichier.
 *
 * ⚠️ Les champs proposés sont EXACTEMENT ceux que `resolveRequesterIdentity` lit. `displayName`
 * n'en fait délibérément pas partie : l'accepter ici laisserait écrire une doublure qui paraît
 * complète et n'empêche rien.
 */
export function makeWorkspaceDouble(
  member: {
    id?: string;
    realName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    teamId?: string;
  } | null = null,
): NonNullable<SlackEventsHandlerOptions['workspaceProvider']> {
  return { findUserById: vi.fn(async () => member) } as unknown as NonNullable<
    SlackEventsHandlerOptions['workspaceProvider']
  >;
}

/**
 * Un registre Mastra dont l'agent LÈVE.
 *
 * C'est le défaut, et c'est un choix : la plupart de ces fichiers vérifient un chemin qui ne
 * doit appeler AUCUN modèle. Un agent qui lève fait échouer bruyamment une fuite, là où un
 * agent complaisant la validerait en silence — sur un budget qui se compte à la journée.
 */
export function makeThrowingMastra(
  message = 'Le modèle ne doit JAMAIS être appelé sur ce chemin',
): { mastra: Mastra; getAgent: ReturnType<typeof vi.fn> } {
  const getAgent = vi.fn(() => {
    throw new Error(message);
  });
  return { mastra: { getAgent } as unknown as Mastra, getAgent };
}

/** Un registre Mastra dont l'agent rend un texte fixe. */
export function makeGeneratingMastra(text: string): {
  mastra: Mastra;
  getAgent: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn().mockResolvedValue({ text });
  const getAgent = vi.fn(() => ({ generate }));
  return { mastra: { getAgent } as unknown as Mastra, getAgent, generate };
}

export interface SlackHandlerOverrides extends Partial<SlackEventsHandlerOptions> {
  /** Registre Mastra. Par défaut un agent qui lève — voir `makeThrowingMastra`. */
  mastra?: Mastra;
  /** Client Slack sous forme de doublure ; équivaut à `slackClient`, mais typé pour la lecture. */
  slack?: SlackMock;
}

export interface SlackHandlerHarness {
  readonly handler: SlackEventsHandler;
  /** Le client Slack effectivement injecté — celui que les tests interrogent. */
  readonly slack: SlackMock;
  /** Les options RÉSOLUES, telles que le handler les a reçues. */
  readonly options: SlackEventsHandlerOptions;
  readonly sendBlocks: ReturnType<typeof vi.fn>;
  /** Les textes postés, dans l'ordre. */
  postedTexts(): string[];
  /** Les textes qui ont REMPLACÉ le marqueur de progression, dans l'ordre. */
  updatedTexts(): string[];
  /** Le texte réellement publié : la mise à jour finale si elle existe, sinon le dernier post. */
  published(): string;
}

const textsOf = (calls: unknown[][]): string[] =>
  calls.map((call) => String((call[0] as { text?: string })?.text ?? ''));

/**
 * Construit un `SlackEventsHandler` dont TOUTES les dépendances neutralisables le sont.
 *
 * Toute option passée en surcharge l'emporte, y compris `null` — un test qui veut vraiment
 * l'absence d'annuaire ou de garde d'accès peut l'exprimer, en connaissance des pièges
 * ci-dessus.
 */
export function makeSlackHandler(overrides: SlackHandlerOverrides = {}): SlackHandlerHarness {
  const { mastra, slack, ...optionOverrides } = overrides;

  const options: SlackEventsHandlerOptions = {
    // ── Les dépendances neutralisées par défaut ────────────────────────────────
    slackClient: (slack ?? makeSlackMock()) as unknown as WebClient,
    chatProvider: {
      sendBlocks: vi.fn().mockResolvedValue({ ts: '1700000000.000901' }),
    } as unknown as SlackEventsHandlerOptions['chatProvider'],
    workspaceProvider: makeWorkspaceDouble(),
    auditSink: async () => undefined,
    conversationRepository: null,
    pinnedFactRepository: null,
    dedupRepository: new InMemorySlackEventDedupRepository(),
    directoryRepository: makeDirectoryDouble(),
    accessGuard: null,
    rateLimiter: null,
    // ── Et le tirage de purge, qui n'est pas une dépendance mais un aléa ───────
    // La production tire à 0,2 : la laisser là ferait porter à un test sur cinq un appel de
    // fond que personne n'a demandé, donc un échec irreproductible.
    pruneProbability: 0,
    // ⚠️ Le dernier mot revient TOUJOURS au test. Une surcharge qui n'écraserait pas la
    // valeur par défaut serait un piège de plus, de la famille de ceux que ce fichier ferme.
    ...optionOverrides,
  };

  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    mastra ?? makeThrowingMastra().mastra,
    options,
  );

  const resolvedSlack = options.slackClient as unknown as SlackMock;
  const sendBlocks = (options.chatProvider as unknown as { sendBlocks: ReturnType<typeof vi.fn> })
    .sendBlocks;

  return {
    handler,
    slack: resolvedSlack,
    options,
    sendBlocks,
    postedTexts: () => textsOf(resolvedSlack.chat.postMessage.mock.calls),
    updatedTexts: () => textsOf(resolvedSlack.chat.update?.mock.calls ?? []),
    published: () => {
      const updates = textsOf(resolvedSlack.chat.update?.mock.calls ?? []);
      if (updates.length > 0) return updates[updates.length - 1]!;
      const posts = textsOf(resolvedSlack.chat.postMessage.mock.calls);
      return posts[posts.length - 1] ?? '';
    },
  };
}
