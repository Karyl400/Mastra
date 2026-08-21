import { logger } from '../../../../shared/logger';
import { NotificationStatus } from '../../../../shared/types';
import { textEmailBody } from '../../domain/services/email-body';
import { safeOutboundText } from './outbound-text';
import {
  MAX_REMINDERS_PER_RUN,
  STALE_AFTER_DAYS,
  STRANDED_CLAIM_MS,
  reminderPreamble,
  selectDueReminders,
  selectStaleReminders,
} from '../../domain/services/reminder-dispatch';
import type { Notification } from '../../domain/entities/notification';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { ChatProvider, EmailProvider } from '../../domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';

export interface DispatchDeps {
  readonly notifications: NotificationRepository;
  readonly employees: EmployeeRepository;
  readonly email: EmailProvider;
  readonly chat: ChatProvider;
  readonly slackWorkspace: SlackWorkspaceProvider;
  readonly now?: () => Date;
}

export interface DispatchReport {
  readonly due: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  /** Périmés : le jour est passé depuis plus d'une semaine. Annulés, jamais remis. */
  readonly stale: number;
  readonly reasons: Readonly<Record<string, number>>;
}

type Outcome = 'sent' | 'failed' | 'skipped';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA REMISE QUOTIDIENNE DES RAPPELS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Appelée par le cron Vercel, et par lui seul. Elle ne fait AUCUN appel de modèle : le sujet
 * et le corps ont été rédigés au moment de l'enregistrement, sous les yeux de la personne qui
 * les a demandés. Les refabriquer à la remise reviendrait à envoyer un texte que personne n'a
 * relu, et à payer un aller-retour par rappel sur un budget qui se compte à la journée.
 *
 * ⚠️ **L'ORDRE DES QUATRE GESTES EST TOUT** : on PREND, on résout, on envoie, on constate.
 *   - prendre AVANT d'envoyer ferme la course entre deux exécutions ;
 *   - rendre la prise sur un échec RÉPARABLE (transport, base) évite de perdre le rappel — la
 *     remise du lendemain le rattrapera ;
 *   - un destinataire introuvable n'est PAS réparable : on marque `failed` et on s'arrête là,
 *     sans quoi le même rappel repartirait en échec tous les matins jusqu'à la fin des temps.
 */
export async function dispatchDueReminders(deps: DispatchDeps): Promise<DispatchReport> {
  const now = deps.now?.() ?? new Date();

  const pending = await deps.notifications.findPending();

  /**
   * ⚠️ **LES PÉRIMÉS SONT ÉTEINTS AVANT TOUT LE RESTE.** Allumer un ordonnanceur réveille tout
   * ce qui dormait : le 2026-08-21, la première exécution a trouvé des lignes écrites des
   * semaines plus tôt, quand rien ne les reprenait. Sans cette extinction, un backlog de six
   * mois partirait par lots de 25, sur des jours, chez des gens qui n'ont rien demandé.
   *
   * On ANNULE plutôt qu'on ne supprime : la trace reste lisible, et un rappel exhumé est un
   * mensonge de plus, pas un service rendu.
   */
  const stale = selectStaleReminders(pending, now);
  for (const old of stale) {
    logger.warn('Rappel périmé — annulé sans remise', {
      id: old.id,
      scheduledAt: old.scheduledAt,
      staleAfterDays: STALE_AFTER_DAYS,
    });
    await deps.notifications.update({
      ...old,
      status: NotificationStatus.Cancelled,
      updatedAt: now.toISOString(),
    });
  }

  const due = selectDueReminders(pending, now, MAX_REMINDERS_PER_RUN);

  if (due.length === MAX_REMINDERS_PER_RUN) {
    // ⚠️ Un plafond silencieux se lit comme « tout a été traité ». On le dit.
    logger.warn('Lot de rappels plafonné — le reste partira à la remise suivante', {
      due: due.length,
      pending: pending.length,
    });
  }

  const reasons: Record<string, number> = {};
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const reminder of due) {
    const outcome = await deliverOne(deps, reminder, now, reasons);
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'failed') failed += 1;
    else skipped += 1;
  }

  logger.info('Remise quotidienne des rappels terminée', {
    due: due.length,
    sent,
    failed,
    skipped,
    stale: stale.length,
  });

  return { due: due.length, sent, failed, skipped, stale: stale.length, reasons };
}

async function deliverOne(
  deps: DispatchDeps,
  reminder: Notification,
  now: Date,
  reasons: Record<string, number>,
): Promise<Outcome> {
  const note = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  // ── 1. LA PRISE ───────────────────────────────────────────────────────────
  const claimed = await deps.notifications.claimForDispatch(
    reminder.id,
    new Date(now.getTime() - STRANDED_CLAIM_MS),
  );
  if (!claimed) {
    logger.info('Rappel déjà pris par une autre exécution — ignoré', { id: reminder.id });
    note('already_claimed');
    return 'skipped';
  }

  // ── 2. LE DESTINATAIRE ────────────────────────────────────────────────────
  let destination: string;
  try {
    const recipient = await deps.employees.findById(reminder.recipientId);
    if (!recipient) {
      await markFailed(deps, reminder, 'recipient_not_found');
      note('recipient_not_found');
      return 'failed';
    }

    if (reminder.channel === 'slack') {
      const member = await deps.slackWorkspace.findUserByEmail(recipient.email);
      if (!member?.id) {
        await markFailed(deps, reminder, 'slack_account_not_found');
        note('slack_account_not_found');
        return 'failed';
      }
      destination = member.id;
    } else {
      if (!recipient.email) {
        await markFailed(deps, reminder, 'no_email');
        note('no_email');
        return 'failed';
      }
      destination = recipient.email;
    }
  } catch (error) {
    // Une base indisponible EST réparable d'ici demain : on rend la prise.
    logger.error('Résolution du destinataire impossible — la prise est rendue', {
      id: reminder.id,
      error: String(error),
    });
    await deps.notifications.releaseClaim(reminder.id);
    note('recipient_lookup_failed');
    return 'skipped';
  }

  // ── 3. L'ENVOI ────────────────────────────────────────────────────────────
  const preamble = reminderPreamble(reminder.scheduledAt);

  /**
   * ⚠️ **SECOND PASSAGE D'ASSAINISSEMENT, et ce n'est pas une redondance.**
   *
   * `scheduleReminder` filtre désormais à l'écriture — mais la production porte des rappels
   * enregistrés AVANT ce correctif du 2026-08-21, et rien ne les relira jamais autrement que
   * par ce chemin-ci. Filtrer seulement à l'écriture n'aurait protégé que l'avenir.
   *
   * C'est la même forme que `generateDocument`, qui filtre au seuil du rendu ET dans le tool :
   * la persistance vit en dehors du renderer, donc une ligne peut entrer par un autre chemin
   * que celui qu'on vient de fermer. L'opération est idempotente — un texte déjà propre en
   * ressort identique, ce qu'un test vérifie.
   *
   * Et c'est ici que ça compte le plus : personne n'est présent au moment de cet envoi.
   */
  const safe = safeOutboundText(
    { subject: reminder.subject, body: reminder.body },
    { id: reminder.id, channel: reminder.channel, path: 'dispatchDueReminders' },
  );

  try {
    if (reminder.channel === 'slack') {
      await deps.chat.sendMessage(destination, `${preamble}\n\n*${safe.subject}*\n\n${safe.body}`);
    } else {
      await deps.email.sendEmail(
        destination,
        safe.subject,
        textEmailBody(`${preamble}\n\n${safe.body}`),
      );
    }
  } catch (error) {
    logger.error('Rappel non remis — échec de transport, la prise est rendue', {
      id: reminder.id,
      channel: reminder.channel,
      error: String(error),
    });
    await deps.notifications.releaseClaim(reminder.id);
    note('transport_failed');
    return 'skipped';
  }

  // ── 4. LE CONSTAT ─────────────────────────────────────────────────────────
  await deps.notifications.update({
    ...reminder,
    status: NotificationStatus.Sent,
    sentAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  logger.info('Rappel remis', {
    id: reminder.id,
    channel: reminder.channel,
    scheduledAt: reminder.scheduledAt,
  });

  return 'sent';
}

async function markFailed(
  deps: DispatchDeps,
  reminder: Notification,
  reason: string,
): Promise<void> {
  logger.error('Rappel non remis — définitivement', { id: reminder.id, reason });
  await deps.notifications.update({
    ...reminder,
    status: NotificationStatus.Failed,
    updatedAt: new Date().toISOString(),
  });
}
