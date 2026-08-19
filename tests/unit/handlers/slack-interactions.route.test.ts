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
/**
 * ⚠️ Identifiant HÉRITÉ, recopié ici à dessein — les boutons ont été retirés du parcours le
 * 2026-08-19 et plus aucun code ne l'émet. Ce test vérifie qu'un clic sur un bouton DÉJÀ POSTÉ
 * dans Slack — ils y restent indéfiniment — ne tombe pas dans le vide.
 */
const COMPLETE_PROFILE_ACTION_ID = 'complete_profile';
/**
 * ⚠️ Identifiants et encodage HÉRITÉS, recopiés ici à dessein. `profile-modal.ts` a été
 * SUPPRIMÉ le 2026-08-19 : il n'existe plus aucune modale, donc plus aucun module d'où les
 * importer. Ils survivent uniquement dans les messages DÉJÀ POSTÉS dans Slack, que rien ne
 * rappelle, et ces tests vérifient qu'un clic ou une soumission venus de là ne tombent pas
 * dans le vide.
 */
const PROFILE_MODAL_CALLBACK_ID = 'employee_profile';
const encodePrefill = (p: {
  slackUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  joinedAt?: string;
}) =>
  JSON.stringify({ u: p.slackUserId, e: p.email, f: p.firstName, l: p.lastName, j: p.joinedAt });

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

/**
 * Soumission venue d'une modale qui N'EXISTE PLUS.
 *
 * ⚠️ Aucun `state` : ce module ne lit plus la saisie, et le type de payload ne le déclare
 * même plus. Le point n'est pas d'enregistrer quoi que ce soit — c'est de ne pas laisser la
 * fenêtre se fermer comme sur un succès.
 */
const viewSubmissionPayload = (callbackId = PROFILE_MODAL_CALLBACK_ID) => ({
  type: 'view_submission',
  user: { id: NEWCOMER },
  view: {
    callback_id: callbackId,
    private_metadata: JSON.stringify({ u: NEWCOMER }),
  },
});

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
    /**
     * ⚠️ CES TESTS ASSERTAIENT L'INVERSE JUSQU'AU 2026-08-19 : « ouvre la modale avec le
     * trigger_id reçu ». Ils verrouillaient un comportement qui ne pouvait PAS fonctionner en
     * production — un `trigger_id` expire 3 secondes après le clic, et l'ACK de cette route a
     * été mesuré ce jour-là à 5 229 ms à froid, 9 173 ms sur un déploiement neuf. Le test
     * passait parce qu'il appelle le handler en mémoire, sans démarrage à froid.
     *
     * C'est la troisième fois en deux jours qu'un test de ce dépôt verrouille un défaut. La
     * leçon est notée dans `CLAUDE.md` : un test qui n'a jamais vu la contrainte réelle ne
     * prouve rien de la production.
     */
    it('n’ouvre PLUS AUCUNE modale, et accuse quand même réception', async () => {
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
      expect(viewsOpen).not.toHaveBeenCalled();
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

  describe('view_submission — la modale a disparu, la personne est PRÉVENUE', () => {
    /**
     * ════════════════════════════════════════════════════════════════════════
     * Le silence aurait été le pire mode d'échec possible
     * ════════════════════════════════════════════════════════════════════════
     *
     * Les deux modales ont été supprimées du dépôt le 2026-08-19 : elles ne s'ouvraient pas
     * (`invalid_trigger_id`, 4,9 s de démarrage à froid contre 3 s accordées). Mais sur une
     * fonction CHAUDE (684 ms mesurées), un bouton déjà posté dans un DM d'hier peut encore
     * l'ouvrir — Slack ne rappelle pas les messages.
     *
     * Sans ce chemin, la personne remplirait le formulaire, cliquerait « Envoyer », verrait la
     * fenêtre se fermer exactement comme sur un succès, et rien ne serait gardé. C'est le mode
     * d'échec que ce dépôt traque depuis `emailSent: false` sous `status: 'success'`, dans sa
     * forme la plus cruelle : elle aurait tapé ses réponses.
     */
    it('accuse réception avec un corps VIDE — la fenêtre doit se fermer', async () => {
      const res = await callRoute(formEncoded(viewSubmissionPayload()));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });

    it('DIT en DM que rien n’a été gardé, et comment faire', async () => {
      await callRoute(formEncoded(viewSubmissionPayload()));
      await new Promise((r) => setTimeout(r, 20));

      const texts = postMessage.mock.calls.map((c) => (c[0] as { text?: string }).text ?? '');
      expect(texts.join(' ')).toMatch(/n’ai rien gardé|n'ai rien gardé/);
      // La marche à suivre, sans quoi le message ne serait qu'un constat d'échec.
      expect(texts.join(' ')).toMatch(/compléter mon profil/i);
    });

    it('ne réaffiche JAMAIS la modale avec des erreurs de champ', async () => {
      // `response_action: 'errors'` laisserait croire qu'un champ est à corriger, alors que
      // c'est le formulaire entier qui n'existe plus.
      const res = await callRoute(formEncoded(viewSubmissionPayload()));
      expect(await res.text()).not.toContain('response_action');
    });

    it('répond pareil à une modale INCONNUE — aucune n’existe plus', async () => {
      const res = await callRoute(formEncoded(viewSubmissionPayload('some_other_modal')));
      expect(res.status).toBe(200);
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
