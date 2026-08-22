import { describe, it, expect, vi, beforeEach } from 'vitest';

import { type SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import { PROFILE_FORM_CHANNEL_REDIRECT } from '../../../src/shared/profile-request';
import { makeSlackHandler, makeThrowingMastra, type SlackMock } from '../../helpers/slack-handler';

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

let slack: SlackMock;
let sendBlocks: ReturnType<typeof vi.fn>;
let getAgent: ReturnType<typeof vi.fn>;
let directory: InMemoryDirectoryRepository;

function makeHandler() {
  // Un agent qui LÈVE : si le court-circuit fuit, le test échoue bruyamment plutôt que de
  // valider silencieusement un appel de modèle qui n'aurait pas dû avoir lieu.
  const mastra = makeThrowingMastra();
  getAgent = mastra.getAgent;
  directory = new InMemoryDirectoryRepository();

  // ⚠️ DIVERGENCE FERMÉE LE 2026-08-22 : ce fichier omettait `pinnedFactRepository`, donc
  // `loadPinnedFacts` aurait fabriqué un `DrizzlePinnedFactRepository` sur la vraie base. Sans
  // conséquence tant que le prédicat de formulaire court-circuitait avant — c'est-à-dire tant
  // que personne ne déplaçait ce prédicat. La fabrique partagée neutralise les HUIT, et son
  // en-tête dit ce que chaque oubli coûte.
  const {
    handler,
    slack: mock,
    sendBlocks: blocks,
  } = makeSlackHandler({
    mastra: mastra.mastra,
    directoryRepository: directory,
  });
  slack = mock;
  sendBlocks = blocks;

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
