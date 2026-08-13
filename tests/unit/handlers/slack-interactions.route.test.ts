import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mastra } from '@mastra/core';

// Aucun test unitaire ne doit toucher l'API Slack réelle.
const { viewsOpen, postMessage } = vi.hoisted(() => ({
  viewsOpen: vi.fn().mockResolvedValue({ ok: true, view: { id: 'V0PROFILE1' } }),
  postMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class FakeWebClient {
    views = { open: viewsOpen };
    chat = { postMessage };
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
