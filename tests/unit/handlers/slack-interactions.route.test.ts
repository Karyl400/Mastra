import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mastra } from '@mastra/core';

// Aucun test unitaire ne doit toucher l'API Slack réelle.
const { viewsOpen, postMessage, chatUpdate } = vi.hoisted(() => ({
  viewsOpen: vi.fn().mockResolvedValue({ ok: true, view: { id: 'V0PROFILE1' } }),
  postMessage: vi.fn().mockResolvedValue({ ok: true }),
  chatUpdate: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class FakeWebClient {
    views = { open: viewsOpen };
    chat = { postMessage, update: chatUpdate };
    auth = { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U0BMBEJTBMJ' }) };
  },
}));

import {
  slackInteractionsRoute,
  SLACK_INTERACTIONS_PATH,
  handleSlackInteractionRequest,
  resetSlackInteractionsAdapter,
  type SlackInteractionsContext,
} from '../../../src/api/slack-interactions.route';
import { computeSlackSignature } from '../../../src/shared/security/slack-signature';
import { COMPLETE_PROFILE_ACTION_ID } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import {
  PROFILE_MODAL_CALLBACK_ID,
  PROFILE_FIELDS,
  encodePrefill,
} from '../../../src/features/notification/infrastructure/handlers/profile-modal';

const SECRET = 'unit-test-signing-secret';
const NEWCOMER = 'U0NEWCOMER1';

function makeContext(rawBody: string, headers: Record<string, string>): SlackInteractionsContext {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: {
      text: async () => rawBody,
      header: (name: string) => lower[name.toLowerCase()],
    },
    get: () => ({}) as Mastra,
  };
}

/** Envoie un corps form-encodé correctement signé. */
async function callRoute(
  rawBody: string,
  options: { signature?: string; timestamp?: string } = {},
): Promise<Response> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = options.signature ?? computeSlackSignature(SECRET, timestamp, rawBody);

  return handleSlackInteractionRequest(
    makeContext(rawBody, {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    }),
  );
}

/** Encode un payload d'interactivité comme Slack le fait réellement. */
function formEncoded(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

const blockActionsPayload = (value: string) => ({
  type: 'block_actions',
  trigger_id: '123456.7890.abcdef',
  user: { id: NEWCOMER, name: 'alice' },
  team: { id: 'TMLKC4EPP' },
  actions: [{ action_id: COMPLETE_PROFILE_ACTION_ID, value }],
});

const viewSubmissionPayload = (overrides: Record<string, string> = {}) => {
  const fields = {
    email: 'alice@kisso.com',
    firstName: 'Alice',
    lastName: 'Martin',
    position: 'Software Engineer',
    ...overrides,
  };

  return {
    type: 'view_submission',
    user: { id: NEWCOMER },
    view: {
      callback_id: PROFILE_MODAL_CALLBACK_ID,
      private_metadata: JSON.stringify({ u: NEWCOMER }),
      state: {
        values: {
          [PROFILE_FIELDS.email.blockId]: {
            [PROFILE_FIELDS.email.actionId]: { value: fields.email },
          },
          [PROFILE_FIELDS.firstName.blockId]: {
            [PROFILE_FIELDS.firstName.actionId]: { value: fields.firstName },
          },
          [PROFILE_FIELDS.lastName.blockId]: {
            [PROFILE_FIELDS.lastName.actionId]: { value: fields.lastName },
          },
          [PROFILE_FIELDS.position.blockId]: {
            [PROFILE_FIELDS.position.actionId]: { value: fields.position },
          },
        },
      },
    },
  };
};

describe('Route /slack/interactions', () => {
  const originalSecret = process.env.SLACK_SIGNING_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSlackInteractionsAdapter();
    process.env.SLACK_SIGNING_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = originalSecret;
  });

  it('is mounted outside the reserved /api prefix', () => {
    // Une route personnalisée sous /api fait échouer le DÉMARRAGE du serveur.
    expect(SLACK_INTERACTIONS_PATH).toBe('/slack/interactions');
    expect(SLACK_INTERACTIONS_PATH.startsWith('/api')).toBe(false);
    expect(slackInteractionsRoute.method).toBe('POST');
    expect(slackInteractionsRoute.path).toBe('/slack/interactions');
  });

  it('declares requiresAuth: false', () => {
    // `server.auth` est actif : sans cette déclaration, chaque requête Slack
    // prend un 401 et Slack finit par désactiver l'endpoint.
    expect((slackInteractionsRoute as unknown as { requiresAuth?: boolean }).requiresAuth).toBe(
      false,
    );
  });

  describe('signature', () => {
    it('rejects a forged signature with 401', async () => {
      const res = await callRoute(formEncoded(blockActionsPayload(NEWCOMER)), {
        signature: 'v0=deadbeef',
      });

      expect(res.status).toBe(401);
      expect(viewsOpen).not.toHaveBeenCalled();
    });

    it('rejects a stale timestamp', async () => {
      const stale = String(Math.floor(Date.now() / 1000) - 400);
      const res = await callRoute(formEncoded(blockActionsPayload(NEWCOMER)), {
        timestamp: stale,
      });

      expect(res.status).toBe(401);
    });
  });

  describe('ssl_check', () => {
    it('answers 200 with an empty body when Slack validates the Request URL', async () => {
      // Sans ce cas, Slack REFUSE d'enregistrer la Request URL d'interactivité
      // et la fonctionnalité n'existe jamais.
      const res = await callRoute('ssl_check=1&token=abc');

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  describe('payload manquant ou illisible', () => {
    it('answers 400 when the payload field is absent', async () => {
      const res = await callRoute('foo=bar');
      expect(res.status).toBe(400);
    });

    it('answers 400 when the payload is not valid JSON', async () => {
      const res = await callRoute(new URLSearchParams({ payload: '{oops' }).toString());
      expect(res.status).toBe(400);
    });
  });

  describe('block_actions', () => {
    it('opens the modal with the received trigger_id and answers an empty 200', async () => {
      const res = await callRoute(
        formEncoded(
          blockActionsPayload(
            encodePrefill({
              slackUserId: NEWCOMER,
              email: 'alice@kisso.com',
              firstName: 'Alice',
              lastName: 'Martin',
            }),
          ),
        ),
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(viewsOpen).toHaveBeenCalledTimes(1);
      expect(viewsOpen.mock.calls[0][0].trigger_id).toBe('123456.7890.abcdef');
    });

    it('prefills the modal from the button value — no extra network call', async () => {
      // Le trigger_id expire en 3 s : aucune E/S ne doit précéder views.open.
      await callRoute(
        formEncoded(
          blockActionsPayload(
            encodePrefill({
              slackUserId: NEWCOMER,
              email: 'alice@kisso.com',
              firstName: 'Alice',
              lastName: 'Martin',
            }),
          ),
        ),
      );

      const serialized = JSON.stringify(viewsOpen.mock.calls[0][0].view);
      expect(serialized).toContain('alice@kisso.com');
      expect(serialized).toContain('Alice');
    });

    it('still answers 200 when Slack refuses to open the modal', async () => {
      viewsOpen.mockRejectedValueOnce(new Error('expired_trigger_id'));

      const res = await callRoute(formEncoded(blockActionsPayload(NEWCOMER)));

      expect(res.status).toBe(200);
    });

    it('ignores a click on another button', async () => {
      const payload = {
        ...blockActionsPayload(NEWCOMER),
        actions: [{ action_id: 'some_other_button', value: 'x' }],
      };

      const res = await callRoute(formEncoded(payload));

      expect(res.status).toBe(200);
      expect(viewsOpen).not.toHaveBeenCalled();
    });
  });

  describe('view_submission', () => {
    it('answers 200 with an EMPTY body on success', async () => {
      // Slack n'accepte qu'un corps vide ou un `response_action`. Un
      // `{"ok":true}` affiche « We had some trouble connecting ».
      const res = await callRoute(formEncoded(viewSubmissionPayload()));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });

    it('accepts a job title absent from the former allowlist', async () => {
      const res = await callRoute(
        formEncoded(viewSubmissionPayload({ position: 'Chief Vibes Officer' })),
      );

      expect(await res.text()).toBe('');
    });

    it('returns response_action errors keyed by block_id on invalid input', async () => {
      const res = await callRoute(formEncoded(viewSubmissionPayload({ email: 'pas-un-email' })));
      const body = (await res.json()) as {
        response_action: string;
        errors: Record<string, string>;
      };

      expect(res.status).toBe(200);
      expect(body.response_action).toBe('errors');
      expect(Object.keys(body.errors)).toEqual([PROFILE_FIELDS.email.blockId]);
    });

    it('never emits an error key that is not a block_id of the modal', async () => {
      // Une clé inconnue est silencieusement ignorée par Slack : la modale se
      // ferme et l'erreur disparaît sans trace.
      const res = await callRoute(
        formEncoded(
          viewSubmissionPayload({
            email: 'x',
            firstName: '',
            position: '',
          }),
        ),
      );
      const body = (await res.json()) as { errors: Record<string, string> };

      const known = new Set<string>(Object.values(PROFILE_FIELDS).map((f) => f.blockId));
      for (const key of Object.keys(body.errors)) {
        expect(known.has(key), `block_id inconnu : ${key}`).toBe(true);
      }
    });

    it('ignores a submission coming from another modal', async () => {
      const payload = viewSubmissionPayload();
      payload.view.callback_id = 'some_other_modal';

      const res = await callRoute(formEncoded(payload));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  it('acknowledges an unknown interaction type without failing', async () => {
    const res = await callRoute(formEncoded({ type: 'shortcut' }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

/* -------------------------------------------------------------------------- *
 * L'ACK des 3 secondes — mesuré à 22,5 s en production
 * -------------------------------------------------------------------------- */

describe('bouton « Envoyer » — l’ACK ne doit pas attendre l’email', () => {
  /**
   * ⚠️ DÉFAUT MESURÉ EN PRODUCTION LE 2026-08-15.
   *
   * Un clic signé sur « Envoyer » a répondu 200 en **22,5 secondes**. L'email partait bien
   * (`Invitation d'entretien envoyée` dans les journaux), mais Slack n'accorde que **3
   * secondes** à une interaction : passé ce délai il affiche une erreur à l'utilisateur.
   *
   * Conséquence concrète, et elle est grave pour un email SORTANT vers un candidat : la
   * personne voit un échec, reclique, et **le candidat reçoit deux invitations**. Le bouton
   * « marchait » tout en paraissant cassé — la pire des combinaisons.
   *
   * L'en-tête de ce fichier énonçait déjà la règle : `view_submission` traite en TÂCHE DE
   * FOND. L'envoi d'entretien, lui, était resté sur le chemin SYNCHRONE de `block_actions`,
   * alors qu'il fait un SMTP complet puis un appel Slack.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    // ⚠️ Ce `describe` est au niveau RACINE : il n'hérite pas du `beforeEach` interne qui pose
    // la clé de signature. Sans elle, la route répond 401 et le test mesurerait le refus.
    process.env.SLACK_SIGNING_SECRET = SECRET;
  });

  it('répond AVANT que l’envoi SMTP ne soit terminé', async () => {
    const { resetRecruitmentDependencies } =
      await import('../../../src/api/slack-interactions.route');
    resetRecruitmentDependencies();

    let releaseSend: (() => void) | undefined;
    const sendStarted = vi.fn();
    const sendEmail = vi.fn().mockImplementation(() => {
      sendStarted();
      return new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });

    const factory =
      await import('../../../src/features/notification/infrastructure/providers/email-provider.factory');
    const spy = vi.spyOn(factory, 'createEmailProvider').mockReturnValue({ sendEmail } as never);

    const confirm = JSON.stringify({
      to: 'candidat@exemple.com',
      candidateName: 'Test Candidat',
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      requesterUserId: NEWCOMER,
    });

    const body = formEncoded({
      type: 'block_actions',
      user: { id: NEWCOMER, name: 'alice' },
      channel: { id: 'D0MOCKDM01' },
      message: { ts: '1700000000.000100' },
      actions: [{ action_id: 'send_interview_email', value: confirm }],
    });

    // LE POINT DU TEST : la route doit rendre la main sans attendre le SMTP.
    const res = await callRoute(body);

    expect(res.status).toBe(200);
    expect(sendStarted).toHaveBeenCalled();

    releaseSend?.();
    spy.mockRestore();
    resetRecruitmentDependencies();
  });
});

/* -------------------------------------------------------------------------- *
 * Le clic irréversible — une seule fois, et la carte le montre
 * -------------------------------------------------------------------------- */

describe('bouton « Envoyer » — un seul email, et une carte neutralisée', () => {
  /**
   * ⚠️ LE SEUL DÉFAUT DE CE DÉPÔT DONT LA CONSÉQUENCE SOIT EXTERNE ET IRRÉVERSIBLE.
   *
   * `handleInterviewSend` n'avait aucune garde d'idempotence — alors que le tool en a une
   * (`schedule-candidate-interview.ts`, `runGuard`) et le workflow d'onboarding aussi
   * (`onboardingRunId`). Deux clics = deux invitations chez le candidat.
   *
   * Et `SlackAdapter.sendBlocks` rend son `ts` avec, en commentaire, « le seul moyen de
   * neutraliser un bouton après son premier clic » — capacité décrite, jamais câblée. La
   * carte restait donc entièrement cliquable, y compris APRÈS « Annuler ».
   *
   * Deux garanties distinctes, et il faut les deux :
   *  • la garde de prise empêche le second envoi (correction) ;
   *  • la mise à jour de la carte empêche le second CLIC (prévention, et surtout : elle
   *    rend l'état visible — sans elle, la personne ne sait pas si son clic a porté, ce qui
   *    est précisément ce qui la fait recliquer).
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SECRET;
    // ⚠️ La garde de prise est un état de MODULE : sans remise à zéro, le premier test
    // consommerait la carte et les suivants verraient leur clic ignoré. C'est exactement le
    // piège déjà documenté dans ce dépôt à propos des compteurs de rationnement partagés
    // entre tests.
    const { resetSettledCards } = await import('../../../src/api/slack-interactions.route');
    resetSettledCards();
  });

  const cardTs = '1700000000.000900';

  const clickBody = (actionId: string) => {
    const confirm = JSON.stringify({
      to: 'candidat@exemple.com',
      candidateName: 'Test Candidat',
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      requesterUserId: NEWCOMER,
    });
    return formEncoded({
      type: 'block_actions',
      user: { id: NEWCOMER, name: 'alice' },
      channel: { id: 'C0MOCKCHAN' },
      message: { ts: cardTs },
      actions: [
        { action_id: actionId, value: actionId === 'send_interview_email' ? confirm : 'cancel' },
      ],
    });
  };

  it('n’envoie QU’UNE FOIS malgré deux clics sur la même carte', async () => {
    const { resetRecruitmentDependencies } =
      await import('../../../src/api/slack-interactions.route');
    resetRecruitmentDependencies();

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const factory =
      await import('../../../src/features/notification/infrastructure/providers/email-provider.factory');
    const spy = vi.spyOn(factory, 'createEmailProvider').mockReturnValue({ sendEmail } as never);

    await callRoute(clickBody('send_interview_email'));
    await callRoute(clickBody('send_interview_email'));

    // Le travail part en tâche de fond : on laisse les microtâches se vider.
    await new Promise((r) => setTimeout(r, 20));

    expect(sendEmail).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    resetRecruitmentDependencies();
  });

  it('NEUTRALISE la carte après l’envoi — plus aucun bouton', async () => {
    const { resetRecruitmentDependencies } =
      await import('../../../src/api/slack-interactions.route');
    resetRecruitmentDependencies();

    const factory =
      await import('../../../src/features/notification/infrastructure/providers/email-provider.factory');
    const spy = vi
      .spyOn(factory, 'createEmailProvider')
      .mockReturnValue({ sendEmail: vi.fn().mockResolvedValue(undefined) } as never);

    await callRoute(clickBody('send_interview_email'));
    await new Promise((r) => setTimeout(r, 20));

    expect(chatUpdate).toHaveBeenCalled();
    const call = chatUpdate.mock.calls[0]?.[0] as { ts?: string; blocks?: unknown[] };
    expect(call?.ts).toBe(cardTs);
    // La carte réécrite ne porte PLUS de bloc `actions` : c'est ce qui rend le second clic
    // impossible, et non seulement inopérant.
    expect(JSON.stringify(call?.blocks ?? [])).not.toContain('"actions"');

    spy.mockRestore();
    resetRecruitmentDependencies();
  });

  it('NEUTRALISE aussi la carte sur « Annuler » — sinon « Envoyer » reste cliquable', async () => {
    await callRoute(clickBody('cancel_interview_email'));
    await new Promise((r) => setTimeout(r, 20));

    expect(chatUpdate).toHaveBeenCalled();
    const call = chatUpdate.mock.calls[0]?.[0] as { ts?: string; blocks?: unknown[] };
    expect(call?.ts).toBe(cardTs);
    expect(JSON.stringify(call?.blocks ?? [])).not.toContain('"actions"');
  });
});

/* -------------------------------------------------------------------------- *
 * Le formulaire échoue : la personne doit l'apprendre
 * -------------------------------------------------------------------------- */

describe('« Compléter mon profil » — un échec ne doit plus être muet', () => {
  /**
   * ⚠️ Le verdict existait, il n'atteignait personne.
   *
   * `onboarding-outcome.ts` distingue `completed` / `degraded` / `failed` précisément pour
   * que « réussi » cesse de couvrir « rien n'est parti ». Mais sur `failed` comme sur
   * `degraded`, l'appelant écrivait une ligne `logger.error` et rendait la main : la personne
   * qui venait de valider sa modale ne recevait RIEN, et ne pouvait pas distinguer un succès
   * d'une panne.
   *
   * C'est le mode d'échec que tout ce dépôt combat, arrêté un cran trop tôt. Le correctif du
   * 2026-08-17 avait traité la CAUSE (conflits `ConflictError` / `UNIQUE`) et pas le chemin
   * d'erreur : toute autre panne — Turso indisponible, workflow absent du registre —
   * reproduisait le même silence.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SECRET;
  });

  /** Contexte dont le registre Mastra ne connaît PAS le workflow. */
  const contextWithoutWorkflow = (rawBody: string): SlackInteractionsContext => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(SECRET, timestamp, rawBody);
    const headers: Record<string, string> = {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    };
    return {
      req: { text: async () => rawBody, header: (n: string) => headers[n.toLowerCase()] },
      get: () => ({ getWorkflow: () => undefined }) as unknown as Mastra,
    };
  };

  it('envoie un message quand le dossier n’a PAS pu être créé', async () => {
    const body = formEncoded(viewSubmissionPayload());

    const res = await handleSlackInteractionRequest(contextWithoutWorkflow(body));
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    // Le point du test : quelque chose est POSTÉ à la personne. Le contenu exact appartient
    // au domaine (`onboarding-replies.ts`) ; ce qui se vérifie ici, c'est le câblage.
    expect(postMessage).toHaveBeenCalled();
    const texts = postMessage.mock.calls.map((c) => (c[0] as { text?: string }).text ?? '');
    expect(texts.join(' ')).toContain("Je n'ai pas réussi à enregistrer ton dossier");
  });
});

describe('les confirmations ne threadent JAMAIS dans un DM', () => {
  /**
   * ⚠️ Corrigé le 2026-08-18, après la vérification en production du threading. C'est une
   * règle établie de ce dépôt : threader un DM enfouit le message hors de la conversation
   * principale, ce qui a déjà fait paraître ce bot muet pendant des heures.
   * `resolveThreadTarget`, côté handler d'événements, applique exactement le même critère.
   *
   * En CANAL, en revanche, la confirmation doit rester attachée à la carte qu'elle confirme —
   * c'était tout l'objet du correctif de `replyInThread`, dont le commentaire promettait
   * depuis l'origine un threading que le code ne faisait pas.
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const { resetSettledCards } = await import('../../../src/api/slack-interactions.route');
    resetSettledCards();
  });

  const cancelIn = (channel: string, ts: string) =>
    formEncoded({
      type: 'block_actions',
      user: { id: NEWCOMER },
      channel: { id: channel },
      message: { ts },
      actions: [{ action_id: 'cancel_interview_email', value: 'cancel' }],
    });

  it('ne pose aucun `thread_ts` en message direct', async () => {
    await callRoute(cancelIn('D0MOCKDM01', '1700000000.001000'));
    await new Promise((r) => setTimeout(r, 20));

    const call = postMessage.mock.calls.at(-1)?.[0] as { thread_ts?: string };
    expect(call?.thread_ts).toBeUndefined();
  });

  it('threade sous la carte en CANAL', async () => {
    await callRoute(cancelIn('C0MOCKCHAN', '1700000000.001100'));
    await new Promise((r) => setTimeout(r, 20));

    const call = postMessage.mock.calls.at(-1)?.[0] as { thread_ts?: string };
    expect(call?.thread_ts).toBe('1700000000.001100');
  });
});
