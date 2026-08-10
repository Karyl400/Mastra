import { describe, it, expect, vi } from 'vitest';
import {
  SlackAdapter,
  type SlackModalView,
} from '../../../src/features/notification/infrastructure/providers/slack.adapter';

/**
 * Client Slack factice : aucun appel réseau en test.
 *
 * On suit la convention de `smtp.adapter.test.ts` — l'adaptateur accepte son
 * client par injection, plutôt que de le fabriquer lui-même à partir du jeton.
 */
function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1723300000.000100' }) },
    views: { open: vi.fn().mockResolvedValue({ ok: true, view: { id: 'V0BM123' } }) },
    ...overrides,
  };
}

/** Vue minimale conforme au type `View` de @slack/web-api. */
const view: SlackModalView = {
  type: 'modal',
  callback_id: 'employee_profile',
  title: { type: 'plain_text', text: 'Mon profil' },
  blocks: [
    {
      type: 'input',
      block_id: 'email',
      label: { type: 'plain_text', text: 'Email' },
      element: { type: 'plain_text_input', action_id: 'value' },
    },
  ],
};

describe('SlackAdapter', () => {
  describe('sendMessage — contrat ChatProvider inchangé', () => {
    it('poste le texte sur le canal', async () => {
      const client = makeClient();
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await adapter.sendMessage('D0BJJDK6QLU', 'Bonjour');

      expect(client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D0BJJDK6QLU',
        text: 'Bonjour',
      });
    });
  });

  describe('sendBlocks', () => {
    it('transmet canal, texte de repli et blocs', async () => {
      const client = makeClient();
      const adapter = new SlackAdapter('xoxb-test', client as never);
      const blocks = [
        { type: 'section' as const, text: { type: 'mrkdwn' as const, text: 'Bienvenue' } },
      ];

      await adapter.sendBlocks('D0BJJDK6QLU', 'Bienvenue chez Kisso', blocks);

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'D0BJJDK6QLU',
          text: 'Bienvenue chez Kisso',
          blocks,
        }),
      );
    });

    it('rend le `ts` du message posté', async () => {
      // Sans le `ts`, impossible de mettre à jour le message pour désactiver le
      // bouton après clic — le bouton d'accueil resterait rejouable à l'infini.
      const adapter = new SlackAdapter('xoxb-test', makeClient() as never);

      const result = await adapter.sendBlocks('D0BJJDK6QLU', 'Repli', []);

      expect(result).toEqual({ ts: '1723300000.000100' });
    });

    it('exige un texte de repli non vide', async () => {
      // Slack documente `text` comme « fallback text for notifications only » :
      // un message à blocs sans repli arrive comme une notification vide, et
      // reste muet pour les lecteurs d'écran.
      const adapter = new SlackAdapter('xoxb-test', makeClient() as never);

      await expect(adapter.sendBlocks('D0BJJDK6QLU', '', [{ type: 'divider' }])).rejects.toThrow(
        /repli/i,
      );
    });

    it('propage les erreurs Slack sans les masquer', async () => {
      const client = makeClient({
        chat: { postMessage: vi.fn().mockRejectedValue(new Error('channel_not_found')) },
      });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await expect(adapter.sendBlocks('D0INVALID', 'Repli', [])).rejects.toThrow(
        /channel_not_found/,
      );
    });
  });

  describe('openModal', () => {
    it('ouvre la vue avec le trigger_id fourni', async () => {
      const client = makeClient();
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await adapter.openModal('123.456.abc', view);

      expect(client.views.open).toHaveBeenCalledWith({ trigger_id: '123.456.abc', view });
    });

    it('rend le `viewId` retourné par Slack', async () => {
      // Nécessaire pour `views.update` : c'est le seul moyen d'enrichir la
      // modale après coup, une fois passé le délai de 3 s du trigger_id.
      const adapter = new SlackAdapter('xoxb-test', makeClient() as never);

      const result = await adapter.openModal('123.456.abc', view);

      expect(result).toEqual({ viewId: 'V0BM123' });
    });

    it('traduit expired_trigger_id en une erreur qui nomme la limite de 3 secondes', async () => {
      // Le trigger_id expire en 3 s. Sans ce message, l'échec est indiscernable
      // d'une panne réseau et se rediagnostique intégralement à chaque fois.
      const client = makeClient({
        views: { open: vi.fn().mockRejectedValue(new Error('expired_trigger_id')) },
      });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await expect(adapter.openModal('123.456.abc', view)).rejects.toThrow(/3 secondes/);
    });

    it('propage les autres erreurs telles quelles', async () => {
      const client = makeClient({
        views: { open: vi.fn().mockRejectedValue(new Error('invalid_arguments')) },
      });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await expect(adapter.openModal('123.456.abc', view)).rejects.toThrow(/invalid_arguments/);
    });
  });
});
