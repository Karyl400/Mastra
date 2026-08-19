import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import { PROFILE_FORM_CHANNEL_REDIRECT } from '../../../src/shared/profile-request';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le septième court-circuit — et le trou qu'il ferme
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `buildWelcomeBlocks` était le SEUL émetteur du bouton « Compléter mon profil », et son
 * seul appelant `handleTeamJoin`. Un salarié déjà présent n'avait donc aucun chemin vers
 * le formulaire — et `team_join` ne figure même pas dans les abonnements de l'app Slack.
 *
 * Relevé sur la Turso de production le 2026-08-14 : `employees` = 2 lignes, quand
 * `slack_directory` porte 4 personnes vivantes de plus, toutes avec `employee_id` à `null`.
 *
 * Ces tests verrouillent les trois propriétés du chemin :
 *   1. le bouton part, et le modèle n'est JAMAIS appelé ;
 *   2. en CANAL, aucun bouton — le pré-remplissage y serait cliquable par un tiers ;
 *   3. `isAnsweredWithoutModel` reconnaît le cas, sans quoi le plafond quotidien
 *      refuserait un geste qui ne coûte rien.
 */

const HUMAN = 'U0BJBDGTJUD';

function makeSlackMock() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };
}

let slack: ReturnType<typeof makeSlackMock>;
let sendBlocks: ReturnType<typeof vi.fn>;
let getAgent: ReturnType<typeof vi.fn>;
let directory: InMemoryDirectoryRepository;

function makeHandler() {
  slack = makeSlackMock();
  sendBlocks = vi.fn().mockResolvedValue({ ts: '1700000000.000901' });
  // Un agent qui LÈVE : si le court-circuit fuit, le test échoue bruyamment plutôt que de
  // valider silencieusement un appel de modèle qui n'aurait pas dû avoir lieu.
  getAgent = vi.fn(() => {
    throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
  });
  directory = new InMemoryDirectoryRepository();

  const mastra = { getAgent } as unknown as Mastra;

  const handler = new SlackEventsHandler('xoxb-test-token', mastra, {
    slackClient: slack as unknown as WebClient,
    chatProvider: { sendBlocks } as unknown as SlackEventsHandlerOptions['chatProvider'],
    // ⚠️ SANS CETTE LIGNE, un `users.info` part RÉELLEMENT vers slack.com avec ce jeton de
    // test : la frontière d'accès construit un `SlackMemberSource` dès qu'on ne lui passe pas
    // explicitement `null`. Mesuré le 2026-08-19 : ≈ 3 s par test, back-off du client compris,
    // donc des tests à quelques centaines de millisecondes du délai de 5 s — la suite entière
    // a échoué deux fois sur neuf exécutions sans qu'aucun comportement ne soit cassé, et ce
    // rouge ne désignait jamais sa cause. `CLAUDE.md` recense les HUIT dépendances à neutraliser.
    accessGuard: null,
    // ⚠️ HUITIÈME dépendance à neutraliser, recensée le 2026-08-19 — et la plus coûteuse
    // restante. `handleMessage` AWAIT l'identité du demandeur avant les court-circuits
    // agissants ; sans cette ligne, `resolveRequesterIdentity` retombe sur
    // `SlackWorkspaceService` et un `users.info` part RÉELLEMENT vers slack.com avec le jeton
    // de test — 0,7 à 1,7 s PAR TEST, le cache étant un LRU par instance et chaque test
    // reconstruisant le handler. C'est ce qui faisait rougir un run sur trois, toujours par
    // `Timeout 5000ms`, jamais par une assertion.
    workspaceProvider: { getUserById: async () => null },
    // ⚠️ Le journal d'audit ouvre `data/kisso.db` par défaut : c'était la DERNIÈRE dépendance
    // non neutralisée de ces tests, ≈ 250 ms par message et, sous contention, des pointes qui
    // franchissent le délai de 5 s de Vitest.
    auditSink: async () => undefined,
    // Les TROIS dépendances qui touchent la base sont neutralisées — sans quoi le handler
    // construit des dépôts Drizzle et les tests écrivent dans la vraie base (cf. CLAUDE.md).
    conversationRepository: null,
    dedupRepository: new InMemorySlackEventDedupRepository(),
    rateLimiter: null,
    pruneProbability: 0,
    directoryRepository: directory,
  });

  return handler;
}

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.000200',
});

const inChannel = (text: string): SlackMessageEvent => ({
  type: 'app_mention',
  user: HUMAN,
  text,
  channel: 'C0MOCKCHAN',
  channel_type: 'channel',
  ts: '1700000000.000100',
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleMessage — demande du formulaire de profil en DM', () => {
  it('poste le GUIDE sans appeler le modèle, et sans aucun bouton', async () => {
    const handler = makeHandler();

    await handler.handleMessage(dm('je veux compléter mon profil'));

    expect(getAgent).not.toHaveBeenCalled();
    expect(sendBlocks).toHaveBeenCalledTimes(1);

    const [channel, , blocks] = sendBlocks.mock.calls[0]!;
    expect(channel).toBe('D0MOCKDM01');

    // ⚠️ PLUS AUCUN BOUTON — 2026-08-19. Le propriétaire a signalé deux fois qu'ils ne
    // fonctionnaient pas sous un vrai clic, alors que les sondes signées mesuraient des ACK de
    // 393 à 1 473 ms, et 1 384 ms à froid. Un désaccord entre une mesure et l'expérience
    // répétée de l'utilisateur ne se tranche pas en répétant la mesure : on supprime la
    // dépendance. Le conversationnel ne dépend que de `message.im`, prouvé à chaque campagne.
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('action_id');
    expect(json).not.toContain('button');
    // Et ce qui remplace le bouton doit être DIT : la personne doit savoir quoi écrire.
    expect(json).toMatch(/j’ai fini|j'ai fini/);
  });

  it('fonctionne même sans rien savoir de la personne', async () => {
    const handler = makeHandler();

    await handler.handleMessage(dm('remplis ma fiche'));

    expect(sendBlocks).toHaveBeenCalledTimes(1);
    expect(getAgent).not.toHaveBeenCalled();
  });
});

describe('handleMessage — demande du formulaire en CANAL', () => {
  it('ne poste AUCUN bouton et redirige vers le DM', async () => {
    // Garantie de sécurité, pas d'ergonomie : le pré-remplissage est figé dans le `value`
    // du bouton. En canal, un témoin qui clique ouvrirait une modale portant les données
    // d'autrui, et sa soumission écrirait le dossier de cette personne.
    const handler = makeHandler();

    await handler.handleMessage(inChannel('je veux compléter mon profil'));

    expect(sendBlocks).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C0MOCKCHAN', text: PROFILE_FORM_CHANNEL_REDIRECT }),
    );
  });
});

describe('isAnsweredWithoutModel — miroir contractuel', () => {
  it('reconnaît la demande de formulaire', () => {
    // ⚠️ CONTRAT : ce prédicat doit être le miroir exact des court-circuits de
    // `handleMessage`. Sans cette ligne, quelqu'un ayant épuisé son quota du jour se verrait
    // répondre « J'ai atteint mon quota » pour un geste qui ne consomme aucun token — et
    // c'est précisément le geste dont tout le reste dépend.
    const handler = makeHandler();
    const probe = handler as unknown as {
      isAnsweredWithoutModel(event: SlackMessageEvent): boolean;
    };

    expect(probe.isAnsweredWithoutModel(dm('je veux compléter mon profil'))).toBe(true);
    expect(probe.isAnsweredWithoutModel(dm('où en est mon dossier ?'))).toBe(false);
  });
});
