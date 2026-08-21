import type { Notification } from '../entities/notification';

export interface NotificationRepository {
  findById(id: string): Promise<Notification | null>;
  findByRecipient(recipientId: string): Promise<Notification[]>;
  findPending(): Promise<Notification[]>;
  save(notification: Notification): Promise<void>;
  update(notification: Notification): Promise<void>;

  /**
   * ⚠️ **LA PRISE EST L'ÉCRITURE, et elle REND UN COMPTE.** Même contrat que `clear()` sur les
   * emails d'entretien en attente, et pour la même raison : deux exécutions du cron — ou un
   * rejeu Vercel — ne doivent pas remettre deux fois le même rappel à quelqu'un.
   *
   * Un `findPending()` suivi d'un `update()` conditionnel côté application — la forme
   * « naturelle » — rouvrirait la course, et son symptôme serait un doublon dans la boîte de
   * quelqu'un. Ici l'`UPDATE … WHERE status IN (…)` est atomique : le second appelant obtient
   * `false` et s'arrête.
   *
   * Rend `true` si ce processus-ci a bien pris le rappel, `false` si quelqu'un d'autre l'avait.
   *
   * ⚠️ `strandedBefore` est la date avant laquelle une prise EN COURS est réputée ABANDONNÉE —
   * une invocation tuée entre la prise et l'envoi (dépassement de `maxDuration`, redéploiement,
   * incident). Sans cette reprise, le rappel resterait `sending` à jamais, invisible de
   * `findPending()` : perdu EN SILENCE, ce qui est pire qu'un doublon — un doublon se voit.
   */
  claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean>;

  /**
   * Rend la prise. Sur un échec de TRANSPORT rien n'est parti : garder le rappel en « envoi en
   * cours » le perdrait pour toujours, alors que la remise du lendemain le rattraperait.
   */
  releaseClaim(id: string): Promise<void>;
}
