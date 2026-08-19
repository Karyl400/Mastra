import { logger } from '../../../../shared/logger';
import { buildInterviewEmail } from '../../domain/services/interview-email';
import { parseInterviewSchedule } from '../../domain/value-objects/interview-schedule';
import {
  PENDING_EMAIL_TTL_MS,
  type PendingInterviewEmail,
} from '../../domain/ports/pending-email.repository';

/**
 * Le « oui » — le seul acte IRRÉVERSIBLE du produit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce qui est REJOUÉ, et ce qui ne l'est jamais
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La table ne porte que des CHAMPS. Le sujet et le corps sont RE-RENDUS ici par le gabarit, et
 * la date RE-VALIDÉE. C'est le contrat que portait le `value` du bouton « Envoyer », et sa
 * raison n'a pas changé : transporter le corps ferait de ce chemin un moyen d'envoyer un texte
 * arbitraire à une adresse arbitraire — la primitive que toute la feature est construite pour
 * ne pas offrir.
 *
 * ⚠️ LA PRISE EST LA SUPPRESSION, et son compte décide. `clear()` rend le nombre de lignes
 * touchées : deux « oui » traités par deux instances ne peuvent pas envoyer deux fois, la
 * seconde rendant 0. Un `find` puis un `delete` conditionnel — la forme « naturelle » —
 * rouvrirait cette course, et son symptôme serait un candidat recevant deux invitations.
 *
 * ⚠️ ON REND LA PRISE sur échec de transport. Rien n'est parti, donc réessayer est légitime et
 * c'est même la seule chose à faire ; effacer obligerait à tout redemander au modèle, soit un
 * aller-retour complet pour une panne SMTP de trente secondes.
 */
export interface ConfirmPendingEmailDeps {
  readonly pending: {
    find(conversationId: string): Promise<PendingInterviewEmail | null>;
    save(pending: PendingInterviewEmail): Promise<void>;
    clear(conversationId: string): Promise<number>;
  };
  readonly sendEmail: (to: string, subject: string, body: string) => Promise<unknown>;
  readonly now?: () => Date;
}

export type ConfirmOutcome =
  | { readonly kind: 'sent'; readonly reply: string }
  | { readonly kind: 'cancelled'; readonly reply: string }
  | { readonly kind: 'not_yours'; readonly reply: string }
  | { readonly kind: 'expired'; readonly reply: string }
  | { readonly kind: 'failed'; readonly reply: string }
  | { readonly kind: 'already_settled'; readonly reply: string };

export const NOT_YOURS_REPLY =
  'Cet email a été préparé par quelqu’un d’autre — c’est à cette personne de le confirmer.';

export const CANCELLED_REPLY =
  'D’accord, je ne l’envoie pas. Rien n’est parti. Redemande-le-moi quand tu veux.';

export const SEND_FAILED_REPLY =
  'Je n’ai pas réussi à envoyer cet email — rien n’est parti. Réessaie dans un instant en me redisant « oui ».';

export const ALREADY_SETTLED_REPLY =
  'Cet email a déjà été tranché — il n’y a plus rien en attente de mon côté.';

export function expiredReply(): string {
  return 'Cette date n’est plus valide, donc rien n’est parti. Redemande-moi l’invitation avec une nouvelle date.';
}

export function sentReply(pending: PendingInterviewEmail, humanReadableDate: string): string {
  const nom = pending.candidateName?.trim();
  const qui = nom ? `${nom} (${pending.to})` : pending.to;
  return `C’est envoyé à *${qui}*, pour le *${humanReadableDate}*.`;
}

/**
 * ⚠️ La phrase de RAPPEL, quand la personne parle d'autre chose. Elle ne bloque rien : on
 * répond au nouveau sujet ET on garde l'email en suspens. Le rappel est là parce qu'un email
 * préparé et oublié est exactement le genre de promesse en creux que ce dépôt traque — sauf
 * qu'ici c'est l'humain qui l'oublierait, pas le code.
 */
export function pendingReminder(pending: PendingInterviewEmail): string {
  const nom = pending.candidateName?.trim() || pending.to;
  return `_(Au fait : l’email d’entretien pour ${nom} attend toujours ton « oui » — ou ton « non ».)_`;
}

/**
 * Cette préparation est-elle ABANDONNÉE ?
 *
 * ⚠️ Vérifié À LA LECTURE et non par un balayage : ce projet n'a aucun cron, et une purge qui
 * dépend d'un automate inexistant est la promesse creuse que ce dépôt traque. Le seul moment
 * où l'on est sûr de regarder cette ligne est celui où quelqu'un parle dans cette conversation.
 */
export function isPendingEmailStale(pending: PendingInterviewEmail, now: Date): boolean {
  return now.getTime() - pending.createdAt.getTime() > PENDING_EMAIL_TTL_MS;
}

/**
 * Ce qu'on dit UNE FOIS quand une préparation a expiré.
 *
 * ⚠️ On le DIT, on ne se contente pas d'effacer. La personne a vu un email complet et une
 * question ; le supprimer en silence la laisserait croire qu'il est peut-être parti. Dire que
 * rien n'est parti est la seule chose vraie et utile — et c'est la discipline `emailSent:
 * false` sous `status: 'success'`, appliquée à un oubli plutôt qu'à une panne.
 */
export function staleReply(pending: PendingInterviewEmail): string {
  const nom = pending.candidateName?.trim() || pending.to;
  return `_(J’ai laissé tomber l’email d’entretien pour ${nom} — il attendait depuis plus d’un jour. Rien n’est parti. Redemande-le-moi si tu en as encore besoin.)_`;
}

export async function confirmPendingEmail(
  deps: ConfirmPendingEmailDeps,
  pending: PendingInterviewEmail,
  clickerUserId: string | undefined,
): Promise<ConfirmOutcome> {
  // ⚠️ Le demandeur, et lui seul. La conversation peut avoir des témoins — en fil de canal,
  // tout le monde voit la question. Sans ce contrôle, un tiers écrirait à l'extérieur au nom
  // de l'entreprise en tapant trois lettres.
  if (!clickerUserId || clickerUserId !== pending.requesterUserId) {
    logger.warn('Envoi d’entretien refusé — le répondant n’est pas le demandeur');
    return { kind: 'not_yours', reply: NOT_YOURS_REPLY };
  }

  const now = (deps.now ?? (() => new Date()))();

  // Re-validation : entre la préparation et le « oui », la date a pu devenir passée.
  const parsed = parseInterviewSchedule(pending.startsAt, now);
  if (!parsed.ok) {
    logger.warn('Envoi d’entretien refusé — date invalide au moment du oui', {
      reason: parsed.reason,
    });
    // Périmée pour de bon : on efface, cette préparation ne pourra plus rien envoyer.
    await deps.pending.clear(pending.conversationId);
    return { kind: 'expired', reply: expiredReply() };
  }

  // ⚠️ LA PRISE. Effacer AVANT d'envoyer, et n'envoyer que si l'on a bien pris : c'est ce qui
  // rend l'envoi unique face à deux instances. L'ordre inverse enverrait deux fois.
  const taken = await deps.pending.clear(pending.conversationId);
  if (taken === 0) {
    logger.info('Email d’entretien déjà tranché — second « oui » ignoré');
    return { kind: 'already_settled', reply: ALREADY_SETTLED_REPLY };
  }

  const email = buildInterviewEmail({
    candidateName: pending.candidateName ?? undefined,
    schedule: parsed.schedule,
    position: pending.position ?? undefined,
    location: pending.location ?? undefined,
    replyTo: pending.replyTo ?? undefined,
  });

  try {
    await deps.sendEmail(pending.to, email.subject, email.body);
  } catch (error) {
    // ⚠️ On ne prétend JAMAIS avoir envoyé, et on REND la prise : rien n'est parti, donc
    // réessayer est légitime. Même discipline que `emailSent: false` sous `status: 'success'`.
    logger.error('Email d’entretien NON envoyé', { error: String(error) });
    await deps.pending.save(pending);
    return { kind: 'failed', reply: SEND_FAILED_REPLY };
  }

  // ⚠️ Aucune écriture en base, et c'est un choix inchangé : stocker l'adresse et l'invitation
  // d'un NON-SALARIÉ créerait des données personnelles sans chemin d'effacement. La trace vit
  // dans le fil Slack et ici, en journal, sans jamais l'adresse complète.
  logger.info('Invitation d’entretien envoyée', {
    recipientDomain: pending.to.split('@')[1] ?? 'inconnu',
    when: parsed.schedule.at.toISOString(),
    hasPosition: Boolean(pending.position),
    hasLocation: Boolean(pending.location),
  });

  return { kind: 'sent', reply: sentReply(pending, parsed.schedule.humanReadable) };
}
