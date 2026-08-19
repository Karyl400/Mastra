import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  PROFILE_DONE_ACTION_ID,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import { decodePrefill } from '../../../src/features/notification/infrastructure/handlers/profile-modal';
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
  it('poste le bouton sans appeler le modèle', async () => {
    const handler = makeHandler();

    await handler.handleMessage(dm('je veux compléter mon profil'));

    expect(getAgent).not.toHaveBeenCalled();
    expect(sendBlocks).toHaveBeenCalledTimes(1);

    const [channel, , blocks] = sendBlocks.mock.calls[0]!;
    expect(channel).toBe('D0MOCKDM01');
    const actions = (
      blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>
    ).find((b) => b.type === 'actions');
    // ⚠️ « C'est fait », plus « Compléter mon profil » — 2026-08-19. Ce chemin-ci (une
    // personne DÉJÀ dans le workspace qui demande son formulaire) était resté sur l'ancien
    // bouton après la refonte du matin, et ce test verrouillait la divergence : pas de
    // vidéo, pas de guide écrit, et surtout aucune vérification — cassé par la même cause
    // que celui qu'on venait de réparer, à savoir un jeton d'ouverture de fenêtre qui expire
    // en 3 s quand le démarrage à froid en prend 5.
    //
    // C'est aussi le chemin le PLUS emprunté : le relevé du 2026-08-14 comptait 2 fiches
    // employés pour 6 personnes réelles, les quatre autres étant arrivées avant
    // l'installation du bot. Le rattrapage passe donc par ici, pas par l'arrivée.
    expect(actions?.elements?.[0]?.action_id).toBe(PROFILE_DONE_ACTION_ID);
  });

  it("pré-remplit le bouton depuis l'annuaire, sans aucun appel Slack supplémentaire", async () => {
    const handler = makeHandler();
    await directory.upsertFacts(
      {
        slackUserId: HUMAN,
        teamId: 'TMLKC4EPP',
        email: 'karylsoumaila1@gmail.com',
        realName: 'Karyl SOUMAILA',
        displayName: 'Karyl SOUMAILA',
        firstName: 'Karyl',
        lastName: 'SOUMAILA',
        title: null,
        isBot: false,
        isAdmin: false,
        isRestricted: false,
        isUltraRestricted: false,
        isDeleted: false,
      },
      new Date(),
    );

    await handler.handleMessage(dm('complète mon profil'));

    const [, , blocks] = sendBlocks.mock.calls[0]!;
    const button = (blocks as Array<{ type: string; elements?: Array<{ value?: string }> }>).find(
      (b) => b.type === 'actions',
    )?.elements?.[0];

    const prefill = decodePrefill(button?.value, '');
    expect(prefill).toMatchObject({
      slackUserId: HUMAN,
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'karylsoumaila1@gmail.com',
    });
  });

  it('fonctionne même sans rien savoir de la personne', async () => {
    // L'annuaire est vide : la modale collectera les quatre champs. L'absence de
    // pré-remplissage ne doit jamais empêcher le geste — c'est le seul chemin qui crée un
    // dossier.
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
