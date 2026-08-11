/**
 * Route HTTP de l'interactivité Slack — clic de bouton et soumission de modale.
 *
 * Distincte de `/slack/events` pour une raison de format, pas d'organisation :
 * les payloads d'interactivité arrivent en `application/x-www-form-urlencoded`
 * (champ `payload=<json>`), là où la route Events ne sait lire que du JSON.
 *
 * ⚠️ Comme pour la route Events, un fichier posé dans `src/api/` n'est PAS monté
 * automatiquement : cette route n'existe que parce que `slackInteractionsRoute`
 * est passé à `server.apiRoutes` dans `src/mastra/index.ts`.
 *
 * ⚠️ Le préfixe `/api` est réservé — une route personnalisée qui commence par lui
 * fait échouer le DÉMARRAGE du serveur, ce n'est pas un 404. D'où `/slack/…`.
 *
 * ⚠️ Cette route applique DEUX régimes opposés, et c'est délibéré :
 *   - `block_actions`   → `views.open` SYNCHRONE, aucune E/S avant lui.
 *                         Le `trigger_id` expire en 3 secondes.
 *   - `view_submission` → traitement lourd en TÂCHE DE FOND (lot 4 : le workflow
 *                         fait base + SMTP + Slack, largement au-delà de 3 s).
 * Ne pas « harmoniser » les deux : c'est ce qui casserait la modale.
 */
import { createHash } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { COMPLETE_PROFILE_ACTION_ID } from '../features/notification/infrastructure/handlers/slack-events.handler';
import {
  PROFILE_MODAL_CALLBACK_ID,
  buildProfileModal,
  decodePrefill,
  errorsByBlockId,
  normalizeStartDate,
  profileSubmissionSchema,
  readProfileSubmission,
  type SlackViewState,
  type ValidatedProfile,
} from '../features/notification/infrastructure/handlers/profile-modal';
import {
  OnboardingOutcome,
  describeDegradation,
  type StepFailure,
} from '../features/onboarding/domain/value-objects/onboarding-outcome';
import { scheduleBackgroundWork } from './slack-events.route';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';

/** Chemin public. À reporter dans *Interactivity & Shortcuts* de l'app Slack. */
export const SLACK_INTERACTIONS_PATH = '/slack/interactions';

/* -------------------------------------------------------------------------- *
 * Types de payload
 * -------------------------------------------------------------------------- */

interface SlackInteractionUser {
  id?: string;
  name?: string;
}

interface SlackBlockAction {
  action_id?: string;
  value?: string;
}

/**
 * Union structurelle plutôt que discriminée : on branche sur `payload.type` en
 * TypeScript. Le payload est du JSON non fiable, et `z.discriminatedUnion` reste
 * proscrit dans ce dépôt (zod épinglé 3.25.76).
 */
interface SlackInteractionPayload {
  type?: string;
  trigger_id?: string;
  user?: SlackInteractionUser;
  team?: { id?: string };
  actions?: SlackBlockAction[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: SlackViewState;
  };
}

/** Sous-ensemble du `Context` Hono réellement utilisé. */
export interface SlackInteractionsContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
}

/* -------------------------------------------------------------------------- *
 * Réponses
 * -------------------------------------------------------------------------- */

/**
 * Accusé de réception : `200` avec un corps **VIDE**.
 *
 * Sur `view_submission`, Slack n'accepte que deux formes : un corps vide (ferme
 * la modale) ou un corps portant `response_action`. Un `{"ok":true}` — le
 * réflexe hérité de la route Events — n'est ni l'un ni l'autre et affiche
 * « We had some trouble connecting » à l'utilisateur.
 */
function ack(): Response {
  return new Response(null, { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* -------------------------------------------------------------------------- *
 * Adaptateur Slack mémorisé
 * -------------------------------------------------------------------------- */

let cachedAdapter: SlackAdapter | undefined;

export function getSlackInteractionsAdapter(): SlackAdapter {
  cachedAdapter ??= new SlackAdapter(process.env.SLACK_BOT_TOKEN ?? '');
  return cachedAdapter;
}

/** Réinitialise le singleton (tests). */
export function resetSlackInteractionsAdapter(): void {
  cachedAdapter = undefined;
}

/* -------------------------------------------------------------------------- *
 * Traitement
 * -------------------------------------------------------------------------- */

/**
 * Clic sur « Compléter mon profil ».
 *
 * `views.open` est appelé AVANT toute autre opération : le `trigger_id` expire
 * 3 secondes après l'interaction, et le pré-remplissage voyage déjà dans le
 * `value` du bouton — donc zéro appel réseau supplémentaire.
 */
async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {
  const action = payload.actions?.find((a) => a.action_id === COMPLETE_PROFILE_ACTION_ID);
  if (!action) return ack();

  const triggerId = payload.trigger_id;
  if (!triggerId) {
    logger.warn('block_actions without a trigger_id, cannot open the modal');
    return ack();
  }

  const prefill = decodePrefill(action.value, payload.user?.id ?? '');

  try {
    await getSlackInteractionsAdapter().openModal(triggerId, buildProfileModal(prefill));
    logger.info('Profile modal opened', { userId: prefill.slackUserId });
  } catch (error) {
    // Ne jamais propager : Slack rejouerait, et le trigger_id serait de toute
    // façon expiré au second essai.
    logger.error('Unable to open the profile modal', { error, userId: prefill.slackUserId });
  }

  return ack();
}

/**
 * Identifiant de run dérivé de l'email.
 *
 * Deux soumissions du même profil produisent le même `runId`, donc le même run
 * — y compris depuis deux instances serverless concurrentes. C'est ce qui rend
 * l'idempotence indépendante du cache mémoire de `create-employee.ts`, inopérant
 * hors d'un processus unique.
 */
export function onboardingRunId(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `onboarding-${digest.slice(0, 32)}`;
}

/**
 * Exécute le workflow d'intégration. Appelé en TÂCHE DE FOND uniquement.
 *
 * ⚠️ `getWorkflow()` prend la CLÉ DU REGISTRE (`src/mastra/index.ts`), pas l'`id`
 * interne du workflow — ce dernier ne se résout que via `getWorkflowById`. Une
 * clé erronée rend `undefined` et lève un `TypeError` **dans la tâche de fond**,
 * donc invisible.
 */
async function runOnboarding(mastra: Mastra, profile: ValidatedProfile): Promise<void> {
  const workflow = mastra.getWorkflow('employeeOnboardingWorkflow' as never) as unknown as {
    createRun(options?: { runId?: string }): Promise<{
      start(args: { inputData: unknown }): Promise<{
        status: string;
        result?: {
          outcome?: OnboardingOutcome;
          emailSent?: boolean;
          slackInvited?: boolean;
          degradedSteps?: StepFailure[];
        };
        error?: unknown;
      }>;
    }>;
  };

  if (!workflow) {
    logger.error('Workflow employeeOnboardingWorkflow introuvable dans le registre Mastra');
    return;
  }

  const run = await workflow.createRun({ runId: onboardingRunId(profile.email) });

  const result = await run.start({
    inputData: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      department: profile.department,
      position: profile.position,
      startDate: normalizeStartDate(profile.startDate),
      // Aucune correspondance département → canal n'existe aujourd'hui :
      // le workflow saute alors l'invitation Slack, sans échouer.
      slackChannelId: null,
    },
  });

  if (result.status !== 'success') {
    logger.error('Onboarding workflow failed', {
      email: profile.email,
      outcome: OnboardingOutcome.Failed,
      error: result.error,
    });
    return;
  }

  // ⚠️ `result.status === 'success'` ne signifie QUE « le workflow est allé au
  // bout ». Le verdict est `result.result.outcome` : les étapes best-effort
  // (email, invitation Slack, tâches) avalent leur exception et laissent le run
  // en `success` même quand rien n'est parti. Journaliser le seul `status`
  // reproduirait exactement le faux « PASS » que ce champ existe pour éliminer.
  const degradedSteps = result.result?.degradedSteps ?? [];

  if (result.result?.outcome === OnboardingOutcome.Degraded) {
    logger.error('Onboarding workflow completed in DEGRADED mode', {
      email: profile.email,
      outcome: result.result.outcome,
      degradedSteps: describeDegradation(degradedSteps),
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });
    return;
  }

  logger.info('Onboarding workflow completed', {
    email: profile.email,
    outcome: result.result?.outcome,
    emailSent: result.result?.emailSent,
    slackInvited: result.result?.slackInvited,
  });
}

/**
 * Soumission de la modale.
 *
 * En cas d'erreur de validation, `response_action: 'errors'` réaffiche la modale
 * avec les messages par champ **sans perdre la saisie**. Les clés sont des
 * `block_id` — une clé inconnue est silencieusement ignorée par Slack.
 */
function handleViewSubmission(payload: SlackInteractionPayload, mastra: Mastra): Response {
  if (payload.view?.callback_id !== PROFILE_MODAL_CALLBACK_ID) return ack();

  const raw = readProfileSubmission(payload.view.state ?? {});
  const parsed = profileSubmissionSchema.safeParse(raw);

  if (!parsed.success) {
    const errors = errorsByBlockId(parsed.error);
    logger.info('Profile submission rejected', { fields: Object.keys(errors) });
    return jsonResponse({ response_action: 'errors', errors });
  }

  const slackUserId = decodePrefill(
    payload.view.private_metadata,
    payload.user?.id ?? '',
  ).slackUserId;

  logger.info('Profile submission accepted', {
    slackUserId,
    department: parsed.data.department,
  });

  // TÂCHE DE FOND — régime OPPOSÉ à celui de `block_actions` ci-dessus : le
  // workflow écrit en base, envoie un email SMTP et appelle Slack, largement
  // au-delà des 3 secondes accordées à cette réponse. Sur Vercel, `waitUntil`
  // empêche le gel de la fonction avant la fin.
  const work = runOnboarding(mastra, parsed.data).catch((error: unknown) => {
    logger.error('Background onboarding failed', { error, email: parsed.data.email });
  });
  scheduleBackgroundWork(work);

  return ack();
}

export async function handleSlackInteractionRequest(
  c: SlackInteractionsContext,
): Promise<Response> {
  // Corps BRUT d'abord : le HMAC porte dessus, et le lire autrement
  // (`c.req.parseBody()`) consommerait le flux.
  const rawBody = await c.req.text();

  const verification = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    rawBody,
  });

  if (!verification.valid) {
    logger.warn('Rejected Slack interaction', { reason: verification.reason });
    return jsonResponse({ error: 'unauthorized', reason: verification.reason }, 401);
  }

  const params = new URLSearchParams(rawBody);

  // À l'enregistrement de la Request URL, Slack envoie un POST `ssl_check=1`
  // SANS champ `payload`. Répondre autrement qu'un 200 fait REFUSER l'URL —
  // et donc la fonctionnalité entière n'existe jamais.
  if (params.get('ssl_check') === '1') {
    logger.info('Slack ssl_check acknowledged');
    return ack();
  }

  // `URLSearchParams.get` décode déjà le pourcentage : un `decodeURIComponent`
  // supplémentaire lèverait « URI malformed » sur le moindre accent.
  const encoded = params.get('payload');
  if (!encoded) {
    logger.warn('Slack interaction without a payload field');
    return jsonResponse({ error: 'missing_payload' }, 400);
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(encoded) as SlackInteractionPayload;
  } catch (error) {
    logger.warn('Slack interaction payload is not valid JSON', { error });
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }

  if (payload.type === 'block_actions') return handleBlockActions(payload);
  if (payload.type === 'view_submission') return handleViewSubmission(payload, c.get('mastra'));

  logger.debug('Slack interaction ignored', { type: payload.type });
  return ack();
}

export const slackInteractionsRoute = registerApiRoute(SLACK_INTERACTIONS_PATH, {
  method: 'POST',
  // OBLIGATOIRE : `server.auth` est actif (src/mastra/index.ts). Sans cette
  // ligne, chaque requête Slack prend un 401 et Slack finit par désactiver
  // l'endpoint — sans autre symptôme qu'une modale qui ne s'ouvre jamais.
  requiresAuth: false,
  openapi: {
    summary: 'Slack interactivity webhook',
    description:
      'Reçoit les interactions Slack (block_actions, view_submission). ' +
      'Signature HMAC-SHA256 vérifiée. Ouvre la modale de profil et valide sa soumission.',
    tags: ['slack'],
    responses: {
      200: { description: 'Interaction accusée (corps vide) ou erreurs de validation' },
      400: { description: 'Payload absent ou illisible' },
      401: { description: 'Signature Slack invalide, absente ou expirée' },
    },
  },
  handler: async (c) => handleSlackInteractionRequest(c as unknown as SlackInteractionsContext),
});
