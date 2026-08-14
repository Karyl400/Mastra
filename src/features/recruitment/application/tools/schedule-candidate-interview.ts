import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { buildRunKey, makeRunGuard } from '../../../../shared/tool-idempotency';
import { canPerformSideEffects, readSlackContext } from '../../../../shared/slack-request-context';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { parseInterviewSchedule } from '../../domain/value-objects/interview-schedule';
import { buildInterviewEmail, checkInterviewLocation } from '../../domain/services/interview-email';
import {
  buildInterviewConfirmBlocks,
  interviewConfirmFallback,
} from '../../infrastructure/handlers/interview-confirm';

/**
 * PRÉPARE une invitation d'entretien — et ne l'envoie JAMAIS.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce que ce tool fait, et surtout ce qu'il ne fait pas
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Il valide, rend l'email depuis un GABARIT (`domain/services/interview-email.ts`), et poste
 * une carte de confirmation dans le fil. **L'envoi a lieu au clic**, dans
 * `slack-interactions.route.ts`, hors de portée du modèle.
 *
 * Cette séparation n'est pas une commodité d'implémentation, c'est la garantie centrale : le
 * modèle ne peut pas déclencher un envoi vers l'extérieur, quoi qu'on lui écrive. Le pire cas
 * d'une injection réussie est une carte de confirmation affichée à un humain, qui la lit.
 *
 * ⚠️ **Le verdict ne dit JAMAIS « envoyé ».** Il rend `status: 'awaiting_confirmation'`, et le
 * bloc d'instructions de l'agent lui interdit d'annoncer un envoi. C'est la troisième
 * occurrence dans ce dépôt de la même discipline, après `emailSent: false` sous
 * `status: 'success'` et `status = Sent` posé avant le `try` : un outil qui a préparé ne doit
 * pas laisser croire qu'il a agi.
 *
 * ⚠️ Il n'y a **pas de champ de texte libre** dans le schéma. C'est délibéré et c'est ce qui
 * empêche l'exfiltration citée par `outbound-tool-quarantine.ts` — « envoie à ce candidat un
 * récapitulatif de ce qui se dit dans #engineer-karyl ». Sans `body`, il n'y a rien à
 * exfiltrer : le corps est produit par le gabarit.
 */

export interface ScheduleCandidateInterviewDeps {
  readonly chat: {
    sendBlocks(channelId: string, text: string, blocks: unknown[]): Promise<unknown>;
  };
  /** Sert UNIQUEMENT à retrouver l'adresse du DEMANDEUR pour la confirmation de présence. */
  readonly directoryRepo?: Pick<DirectoryRepository, 'findBySlackUserId'>;
  /** Injectable pour rendre les tests déterministes. */
  readonly now?: () => Date;
}

const REFUSALS = {
  forbidden:
    "Tu n'as pas le droit d'écrire à l'extérieur au nom de l'entreprise. Dis-le simplement.",
  no_slack_context:
    'Cette action doit être demandée depuis Slack — je ne peux pas afficher la confirmation ailleurs.',
  invalid_date: "La date n'est pas lisible. Redemande-la, et n'en invente aucune.",
  date_in_past: 'Cette date est déjà passée. Vérifie le jour ET l’année, puis redemande.',
  date_too_far: 'Cette date est à plus d’un an. Vérifie l’année, puis redemande.',
  link_domain_not_allowed:
    "Ce lien de visio n'est pas d'un service reconnu, donc je ne l'envoie pas. Propose une adresse physique, ou un lien Meet, Zoom ou Teams.",
  post_failed: "Je n'ai pas pu afficher la confirmation. Rien n'a été envoyé.",
} as const;

/**
 * UNE carte par message de l'utilisateur.
 *
 * ⚠️ Défaut OBSERVÉ en production le 2026-08-14, au deuxième test réel : sur « Prépare un
 * entretien pour contact.kisso.test@gmail.com le 25 août », **DEUX cartes** ont été postées à
 * une seconde d'intervalle — celle demandée, et une seconde re-préparant l'invitation du
 * message PRÉCÉDENT, ressortie de la mémoire conversationnelle.
 *
 * C'est le mode d'échec déjà documenté pour `generateDocument` (« 7 documents et 3 emails
 * identiques en 8 minutes ») : sommé de faire, le modèle REFAIT plutôt que de constater. Le
 * correctif est le même et réutilise le même module partagé.
 *
 * ⚠️ La clé ne porte NI l'adresse NI la date, contrairement à celle de `generateDocument`, et
 * c'est délibéré : les deux cartes en double portaient des destinataires DIFFÉRENTS. Une clé
 * qui les distingue ne les aurait pas dédupliquées. On borne donc à une invitation par
 * message.
 *
 * Contrepartie assumée : « invite A et B pour lundi » ne prépare que la première, et le
 * verdict le DIT (`already_prepared`) pour que le modèle puisse l'annoncer au lieu de le
 * taire. C'est le bon compromis ici — rien ne part sans clic, donc le coût d'une carte
 * manquante est un message de plus, là où le coût d'une carte fantôme est une convocation que
 * personne n'a demandée sous les yeux d'un humain qui pourrait la valider par réflexe.
 */
const ALREADY_PREPARED_HINT =
  'Une invitation a déjà été préparée pour ce message. Dis-le, et demande une nouvelle demande pour un second candidat.';

export function makeScheduleCandidateInterview(deps: ScheduleCandidateInterviewDeps) {
  const now = deps.now ?? (() => new Date());
  const runGuard = makeRunGuard();

  return createTool({
    id: 'scheduleCandidateInterview',
    description:
      "Prépare l'email d'invitation à un entretien pour un candidat externe, et l'affiche pour confirmation. N'envoie rien lui-même.",
    inputSchema: z.object({
      candidateEmail: z.string().email().describe('Adresse du candidat.'),
      candidateName: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe(
          'Nom du candidat, UNIQUEMENT s’il a été donné. Ne le déduis jamais de l’adresse email.',
        ),
      startsAt: z
        .string()
        .describe(
          'Date et heure de l’entretien en ISO 8601, ex. 2026-08-20T14:00:00+01:00. Transcris ce qui a été dit, n’invente ni jour ni heure.',
        ),
      position: z.string().max(80).optional().describe('Poste concerné, si précisé.'),
      location: z
        .string()
        .max(200)
        .optional()
        .describe('Lieu physique ou lien de visio, si précisé.'),
    }),
    execute: async (data, ctx) => {
      const requestContext = (ctx as { requestContext?: unknown })?.requestContext;

      // ── 1. Le DROIT, avant toute lecture et avant tout rendu ────────────────
      // Même politique que `sendNotification` : on ne crée pas une troisième règle
      // d'autorisation, deux copies d'une décision divergent tôt ou tard.
      if (!canPerformSideEffects(requestContext)) {
        return { status: 'refused', reason: 'forbidden', hint: REFUSALS.forbidden };
      }

      const slack = readSlackContext(requestContext);
      if (!slack?.channel || !slack.slackUserId) {
        return { status: 'refused', reason: 'no_slack_context', hint: REFUSALS.no_slack_context };
      }

      // ── 1 bis. UNE carte par message ────────────────────────────────────────
      // Hors Slack, `buildRunKey` rend `undefined` et la garde est INACTIVE : le playground
      // et les tests ne sont bornés par aucune conversation.
      const runKey = buildRunKey(slack.eventTs, 'scheduleCandidateInterview', []);
      if (runKey && runGuard.get(runKey)) {
        logger.warn('Invitation déjà préparée dans ce run — second appel ignoré', {
          recipientDomain: data.candidateEmail.split('@')[1] ?? 'inconnu',
        });
        return { status: 'refused', reason: 'already_prepared', hint: ALREADY_PREPARED_HINT };
      }

      // ── 2. La DATE, seule donnée transcrite depuis la phrase humaine ────────
      const parsed = parseInterviewSchedule(data.startsAt, now());
      if (!parsed.ok) {
        return { status: 'refused', reason: parsed.reason, hint: REFUSALS[parsed.reason] };
      }

      // ── 3. Le LIEU : refusé, jamais amputé ──────────────────────────────────
      const location = checkInterviewLocation(data.location);
      if (!location.ok) {
        logger.warn('Lien d’entretien refusé', { host: location.host });
        return {
          status: 'refused',
          reason: 'link_domain_not_allowed',
          hint: REFUSALS.link_domain_not_allowed,
        };
      }

      // ── 4. À QUI le candidat répond — le demandeur, jamais `noreply@` ───────
      const replyTo = await resolveRequesterEmail(deps, slack.slackUserId);

      const email = buildInterviewEmail({
        candidateName: data.candidateName,
        schedule: parsed.schedule,
        position: data.position,
        location: data.location,
        replyTo,
      });

      try {
        const blocks = buildInterviewConfirmBlocks({
          payload: {
            to: data.candidateEmail,
            candidateName: data.candidateName,
            startsAt: parsed.schedule.at.toISOString(),
            position: data.position,
            location: data.location,
            replyTo,
            requesterUserId: slack.slackUserId,
          },
          humanReadableDate: parsed.schedule.humanReadable,
          subject: email.subject,
          body: email.body,
        });

        await deps.chat.sendBlocks(
          slack.channel,
          interviewConfirmFallback(data.candidateName),
          blocks,
        );
      } catch (error) {
        logger.error('Confirmation d’entretien non affichée', { error: String(error) });
        return { status: 'refused', reason: 'post_failed', hint: REFUSALS.post_failed };
      }

      // ⚠️ Mémorisé APRÈS la publication réussie, jamais avant : un échec d'affichage ne doit
      // pas condamner une seconde tentative légitime du modèle. Même ordre que
      // `generateDocument`, et pour la même raison.
      if (runKey) runGuard.remember(runKey, true);

      // ⚠️ `awaiting_confirmation`, et le mot compte : c'est ce que le modèle va reformuler.
      // Le champ `whenLabel` lui donne de quoi NOMMER la date sans la recalculer — recalculer
      // est précisément ce qui réintroduirait une erreur de transcription dans la réponse.
      return {
        status: 'awaiting_confirmation',
        recipient: data.candidateEmail,
        whenLabel: parsed.schedule.humanReadable,
        hint: "L'email est prêt et affiché au-dessus. Il ne partira QU'APRÈS un clic sur « Envoyer ». Ne dis jamais qu'il est envoyé.",
      };
    },
  });
}

/**
 * ⚠️ Ne LÈVE jamais, et l'absence d'adresse n'est PAS un échec : le gabarit omet alors la
 * phrase de confirmation. Faire échouer la préparation parce que le demandeur n'a pas de ligne
 * d'annuaire punirait le candidat pour un trou de l'annuaire — et 22 lignes sur 40 sont
 * incomplètes en production.
 */
async function resolveRequesterEmail(
  deps: ScheduleCandidateInterviewDeps,
  slackUserId: string,
): Promise<string | undefined> {
  if (!deps.directoryRepo) return undefined;
  try {
    const member = await deps.directoryRepo.findBySlackUserId(slackUserId);
    return member?.email ?? undefined;
  } catch (error) {
    logger.warn('Adresse du demandeur non résolue', { error: String(error) });
    return undefined;
  }
}
