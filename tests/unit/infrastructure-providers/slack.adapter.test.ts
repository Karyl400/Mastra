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
    files: {
      uploadV2: vi
        .fn()
        .mockResolvedValue(uploadV2Response('https://kissohq.slack.com/files/U0/F1/guide.pdf')),
    },
    ...overrides,
  };
}

/**
 * Retour réel de `files.uploadV2` tel que le construit `WebClient.filesUploadV2`
 * dans @slack/web-api 8.0.0 : `{ ok, files: [<réponse files.completeUploadExternal>] }`,
 * chaque réponse portant elle-même un tableau `files` d'objets `File`.
 *
 * Le permalink est donc DOUBLEMENT imbriqué (`res.files[0].files[0].permalink`),
 * contrairement au `files.upload` v1 qui rendait un unique objet `file`. C'est
 * précisément le piège que l'extraction défensive doit absorber.
 */
function uploadV2Response(permalink?: string) {
  return {
    ok: true,
    files: [
      { ok: true, files: [{ id: 'F1', name: 'guide.pdf', ...(permalink ? { permalink } : {}) }] },
    ],
  };
}

/** Erreur telle que la lève le SDK : le code utile est dans `data.error`, pas dans le message. */
function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { ok: false, error: code },
  });
}

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // « %PDF »

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

  describe('uploadFile', () => {
    it('transmet le binaire, le nom de fichier et le canal à files.uploadV2', async () => {
      const client = makeClient();
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await adapter.uploadFile({
        channel: 'D0BJJDK6QLU',
        bytes,
        filename: 'guide.pdf',
        title: 'Guide d’intégration',
        initialComment: 'Voici ton guide',
      });

      const args = client.files.uploadV2.mock.calls[0][0];
      // `channel_id` et non `channels` : la v2 a déprécié `channels`, qui ne
      // supporte plus la liste séparée par des virgules et déclenche un warning.
      expect(args.channel_id).toBe('D0BJJDK6QLU');
      expect(args.filename).toBe('guide.pdf');
      expect(args.title).toBe('Guide d’intégration');
      expect(args.initial_comment).toBe('Voici ton guide');
      // Le SDK n'accepte pas un `Uint8Array` nu : il attend un Buffer, un Stream
      // ou un CHEMIN de fichier — une chaîne serait lue depuis le disque.
      expect(Buffer.isBuffer(args.file)).toBe(true);
      expect(Buffer.from(args.file).equals(Buffer.from(bytes))).toBe(true);
    });

    it('poste dans le fil quand un threadTs est fourni', async () => {
      const client = makeClient();
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await adapter.uploadFile({
        channel: 'CMLKC4S5T',
        threadTs: '1723300000.000100',
        bytes,
        filename: 'guide.pdf',
      });

      expect(client.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({ channel_id: 'CMLKC4S5T', thread_ts: '1723300000.000100' }),
      );
    });

    it('omet thread_ts hors fil plutôt que de l’envoyer à undefined', async () => {
      const client = makeClient();
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await adapter.uploadFile({ channel: 'D0BJJDK6QLU', bytes, filename: 'guide.pdf' });

      expect(client.files.uploadV2.mock.calls[0][0]).not.toHaveProperty('thread_ts');
    });

    it('extrait le permalink du retour doublement imbriqué de la v2', async () => {
      const adapter = new SlackAdapter('xoxb-test', makeClient() as never);

      const result = await adapter.uploadFile({
        channel: 'D0BJJDK6QLU',
        bytes,
        filename: 'guide.pdf',
      });

      expect(result).toEqual({ permalink: 'https://kissohq.slack.com/files/U0/F1/guide.pdf' });
    });

    it('rend `permalink: undefined` — jamais une exception — quand le champ manque', async () => {
      // Le fichier EST livré même sans permalink dans la réponse ; faire lever ici
      // transformerait une livraison réussie en échec.
      const client = makeClient({
        files: { uploadV2: vi.fn().mockResolvedValue(uploadV2Response(undefined)) },
      });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await expect(
        adapter.uploadFile({ channel: 'D0BJJDK6QLU', bytes, filename: 'guide.pdf' }),
      ).resolves.toEqual({ permalink: undefined });
    });

    it('rend `permalink: undefined` quand la forme du retour est inattendue', async () => {
      const client = makeClient({ files: { uploadV2: vi.fn().mockResolvedValue({ ok: true }) } });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await expect(
        adapter.uploadFile({ channel: 'D0BJJDK6QLU', bytes, filename: 'guide.pdf' }),
      ).resolves.toEqual({ permalink: undefined });
    });

    it('traduit missing_scope en une erreur qui nomme le scope ET la réinstallation', async () => {
      // Le scope `files:write` n'est pas accordé au bot. L'ajouter dans la console
      // ne suffit pas : sans réinstallation, le jeton du workspace garde l'ancien
      // jeu de scopes — piège déjà vécu sur ce projet en 2026-08-08.
      const client = makeClient({
        files: { uploadV2: vi.fn().mockRejectedValue(slackPlatformError('missing_scope')) },
      });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      const rejection = adapter.uploadFile({
        channel: 'D0BJJDK6QLU',
        bytes,
        filename: 'guide.pdf',
      });

      await expect(rejection).rejects.toThrow(/files:write/);
      await expect(rejection).rejects.toThrow(/réinstall/i);
    });

    it('propage les autres erreurs Slack sans les masquer', async () => {
      const client = makeClient({
        files: { uploadV2: vi.fn().mockRejectedValue(slackPlatformError('not_in_channel')) },
      });
      const adapter = new SlackAdapter('xoxb-test', client as never);

      await expect(
        adapter.uploadFile({ channel: 'CMA1TPCN6', bytes, filename: 'guide.pdf' }),
      ).rejects.toThrow(/not_in_channel/);
    });
  });
});
