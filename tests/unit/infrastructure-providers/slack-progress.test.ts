import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startProgress,
  PROGRESS_MARKER_TEXT,
} from '../../../src/features/notification/infrastructure/providers/slack-progress';
import { logger } from '../../../src/shared/logger';

/**
 * Le logger est mocké : les dégradations du marqueur DOIVENT être journalisées
 * en `warn` (c'est la contrepartie de « ne jamais faire échouer le traitement
 * principal » — sans trace, une panne silencieuse deviendrait invisible), et on
 * évite au passage d'inonder la sortie des tests.
 */
vi.mock('../../../src/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Client Slack factice : aucun appel réseau en test.
 *
 * Même convention que `slack.adapter.test.ts` — la brique reçoit son client par
 * injection plutôt que de le fabriquer à partir du jeton.
 */
function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1723300000.000100' }),
      update: vi.fn().mockResolvedValue({ ok: true, ts: '1723300000.000100' }),
      ...(overrides.chat as object | undefined),
    },
  };
}

const target = { channel: 'C0BJGBVB5HP', threadTs: '1723299999.000900' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startProgress', () => {
  describe('chemin nominal', () => {
    it('poste le marqueur de progression immédiatement', async () => {
      const client = makeClient();

      await startProgress(client as never, target);
      // Le post part sans `await` : on laisse la microtâche s'écouler.
      await Promise.resolve();

      expect(client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0BJGBVB5HP',
        text: PROGRESS_MARKER_TEXT,
        thread_ts: '1723299999.000900',
      });
    });

    it('remplace le marqueur par le texte final, avec le `ts` du marqueur', async () => {
      const client = makeClient();

      const progress = await startProgress(client as never, target);
      await progress.resolve('Voici ta réponse.');

      expect(client.chat.update).toHaveBeenCalledWith({
        channel: 'C0BJGBVB5HP',
        ts: '1723300000.000100',
        text: 'Voici ta réponse.',
      });
    });

    it('ne poste QU’UN message : la réponse remplace le marqueur, elle ne s’y ajoute pas', async () => {
      // Deux messages laisseraient « Je regarde ça… » en permanence dans le fil.
      const client = makeClient();

      const progress = await startProgress(client as never, target);
      await progress.resolve('Voici ta réponse.');

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: PROGRESS_MARKER_TEXT }),
      );
    });

    it('le marqueur ne contient aucun emoji', async () => {
      // Cohérence avec `sanitizeAgentOutput`, qui en retire de toute réponse d'agent.
      const emoji = /\p{Extended_Pictographic}|:[a-z0-9_+-]+:/u;
      expect(PROGRESS_MARKER_TEXT).not.toMatch(emoji);
    });
  });

  describe('budget de latence', () => {
    it("rend la main sans attendre l'aller-retour Slack", async () => {
      // Le marqueur doit partir en PARALLÈLE de l'appel LLM, pas avant lui :
      // l'attendre ajouterait 200-500 ms à chaque message reçu.
      const neverSettles = new Promise<never>(() => {});
      const client = makeClient({ chat: { postMessage: vi.fn().mockReturnValue(neverSettles) } });

      const progress = await Promise.race([
        startProgress(client as never, target),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('startProgress a bloqué')), 50),
        ),
      ]);

      expect(progress).toHaveProperty('resolve');
    });
  });

  describe('threadTs', () => {
    it('threade le marqueur quand `threadTs` est fourni', async () => {
      const client = makeClient();

      await startProgress(client as never, target);
      await Promise.resolve();

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1723299999.000900' }),
      );
    });

    it('ne threade pas quand `threadTs` est absent (cas du DM)', async () => {
      // En DM, threader enfouit la réponse hors de la conversation principale.
      const client = makeClient();

      await startProgress(client as never, { channel: 'D0BJJDK6QLU' });
      await Promise.resolve();

      expect(client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D0BJJDK6QLU',
        text: PROGRESS_MARKER_TEXT,
      });
      const [payload] = client.chat.postMessage.mock.calls[0] as [Record<string, unknown>];
      expect(payload).not.toHaveProperty('thread_ts');
    });

    it('threade aussi le repli quand la mise à jour échoue', async () => {
      const client = makeClient({
        chat: {
          postMessage: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, ts: '1723300000.000100' })
            .mockResolvedValueOnce({ ok: true, ts: '1723300001.000200' }),
          update: vi.fn().mockRejectedValue(new Error('message_not_found')),
        },
      });

      const progress = await startProgress(client as never, target);
      await progress.resolve('Voici ta réponse.');

      expect(client.chat.postMessage).toHaveBeenLastCalledWith({
        channel: 'C0BJGBVB5HP',
        text: 'Voici ta réponse.',
        thread_ts: '1723299999.000900',
      });
    });
  });

  describe('le marqueur ne fait JAMAIS échouer le traitement principal', () => {
    it('poste quand même la réponse finale si le marqueur initial a échoué', async () => {
      // `not_in_channel` : le bot n'est membre que de 2 des 5 canaux (CLAUDE.md).
      const client = makeClient({
        chat: {
          postMessage: vi
            .fn()
            .mockRejectedValueOnce(new Error('not_in_channel'))
            .mockResolvedValueOnce({ ok: true, ts: '1723300001.000200' }),
          update: vi.fn(),
        },
      });

      const progress = await startProgress(client as never, target);
      await expect(progress.resolve('Voici ta réponse.')).resolves.toBeUndefined();

      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'Voici ta réponse.' }),
      );
    });

    it('journalise en `warn` — pas en `error` — quand le marqueur initial échoue', async () => {
      const client = makeClient({
        chat: {
          postMessage: vi
            .fn()
            .mockRejectedValueOnce(new Error('rate_limited'))
            .mockResolvedValueOnce({ ok: true, ts: '1723300001.000200' }),
          update: vi.fn(),
        },
      });

      const progress = await startProgress(client as never, target);
      await progress.resolve('Voici ta réponse.');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('progress marker'),
        expect.objectContaining({ channel: 'C0BJGBVB5HP' }),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('se rabat sur un postMessage quand `chat.update` échoue', async () => {
      const client = makeClient({
        chat: {
          postMessage: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, ts: '1723300000.000100' })
            .mockResolvedValueOnce({ ok: true, ts: '1723300001.000200' }),
          update: vi.fn().mockRejectedValue(new Error('cant_update_message')),
        },
      });

      const progress = await startProgress(client as never, target);
      await expect(progress.resolve('Voici ta réponse.')).resolves.toBeUndefined();

      expect(client.chat.update).toHaveBeenCalledTimes(1);
      expect(client.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'Voici ta réponse.' }),
      );
    });

    it('se rabat aussi quand Slack répond sans `ts`', async () => {
      // Un `ok` sans `ts` ne donne aucune prise pour `chat.update`.
      const client = makeClient({
        chat: {
          postMessage: vi
            .fn()
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true, ts: '1723300001.000200' }),
          update: vi.fn(),
        },
      });

      const progress = await startProgress(client as never, target);
      await progress.resolve('Voici ta réponse.');

      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'Voici ta réponse.' }),
      );
    });

    it("ne consomme le marqueur qu'une fois : un second `resolve` n'écrase pas la réponse livrée", async () => {
      const client = makeClient();

      const progress = await startProgress(client as never, target);
      await progress.resolve('Première réponse.');
      await progress.resolve('Seconde réponse.');

      expect(client.chat.update).toHaveBeenCalledTimes(1);
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Première réponse.' }),
      );
      expect(client.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'Seconde réponse.' }),
      );
    });
  });

  describe('resolve — échec de la livraison finale', () => {
    it("propage quand la réponse n'a atteint personne", async () => {
      // Le marqueur est un confort et se tait ; la réponse, elle, est le
      // traitement principal : l'appelant doit savoir qu'elle est perdue.
      const client = makeClient({
        chat: {
          postMessage: vi.fn().mockRejectedValue(new Error('channel_not_found')),
          update: vi.fn(),
        },
      });

      const progress = await startProgress(client as never, target);

      await expect(progress.resolve('Voici ta réponse.')).rejects.toThrow(/channel_not_found/);
    });
  });

  describe('fail', () => {
    it("remplace le marqueur par le message d'erreur", async () => {
      const client = makeClient();

      const progress = await startProgress(client as never, target);
      await progress.fail("Désolé, une erreur s'est produite.");

      expect(client.chat.update).toHaveBeenCalledWith({
        channel: 'C0BJGBVB5HP',
        ts: '1723300000.000100',
        text: "Désolé, une erreur s'est produite.",
      });
    });

    it("poste le message d'erreur même sans marqueur", async () => {
      const client = makeClient({
        chat: {
          postMessage: vi
            .fn()
            .mockRejectedValueOnce(new Error('not_in_channel'))
            .mockResolvedValueOnce({ ok: true, ts: '1723300001.000200' }),
          update: vi.fn(),
        },
      });

      const progress = await startProgress(client as never, target);
      await progress.fail("Désolé, une erreur s'est produite.");

      expect(client.chat.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Désolé, une erreur s'est produite." }),
      );
    });

    it('ne lève JAMAIS, même quand tout échoue', async () => {
      // On est déjà sur le chemin d'erreur : lever ici masquerait la cause
      // d'origine derrière une panne Slack.
      const client = makeClient({
        chat: {
          postMessage: vi.fn().mockRejectedValue(new Error('channel_not_found')),
          update: vi.fn().mockRejectedValue(new Error('channel_not_found')),
        },
      });

      const progress = await startProgress(client as never, target);

      await expect(progress.fail("Désolé, une erreur s'est produite.")).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
