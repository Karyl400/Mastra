import { describe, expect, it, vi } from 'vitest';

import {
  MAX_REMINDERS_PER_RUN,
  REMINDER_DISPATCH_HOUR_UTC,
  REMINDER_DISPATCH_PATH,
  REMINDER_DISPATCH_SCHEDULE,
  STRANDED_CLAIM_MS,
  deliveryLabel,
  isDueForDispatch,
  isStrandedClaim,
  nextDeliveryAt,
  reminderPreamble,
  selectDueReminders,
} from '../../../src/features/notification/domain/services/reminder-dispatch';
import {
  dispatchDueReminders,
  type DispatchDeps,
} from '../../../src/features/notification/application/services/dispatch-due-reminders';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../src/shared/types';
import type { Notification } from '../../../src/features/notification/domain/entities/notification';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « CE N'EST PAS LE BUT D'UN RAPPEL » — le verdict du propriétaire, 2026-08-21
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Marcel répondait : « je ne sais pas te relancer tout seul le jour venu — repasse me le
 * demander ». C'était honnête, et c'était exactement le défaut : un rappel dont il faut se
 * souvenir n'est pas un rappel.
 *
 * La cause n'était ni un oubli ni une paresse. Dans un serverless RIEN NE S'EXÉCUTE tant que
 * personne ne frappe à la porte : aucun `setTimeout` ne survit au gel de la fonction, et
 * `findPending()` — écrite, correcte — n'avait aucun site d'appel parce qu'il n'existait
 * personne pour l'appeler. Il manquait une HORLOGE EXTÉRIEURE, la seule chose qu'une fonction
 * ne peut pas se donner à elle-même.
 */

const BASE: Omit<Notification, 'id' | 'status' | 'scheduledAt'> = {
  recipientId: '11111111-1111-4111-8111-111111111111',
  recipientType: RecipientType.Employee,
  channel: NotificationChannel.Email,
  subject: 'Relire les guidelines',
  body: 'Tu voulais relire les guidelines de l’équipe.',
  createdAt: '2026-08-21T10:00:00.000Z',
  updatedAt: '2026-08-21T10:00:00.000Z',
};

function reminder(overrides: Partial<Notification> = {}): Notification {
  return {
    ...BASE,
    id: overrides.id ?? crypto.randomUUID(),
    status: NotificationStatus.Scheduled,
    scheduledAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  } as Notification;
}

describe('un rappel est dû quand son JOUR est arrivé, pas à son heure', () => {
  // ⚠️ Le piège est ici, et il est contre-intuitif. La remise a lieu le MATIN. Si l'on
  // attendait l'heure exacte, un rappel « lundi 9 h » ne serait vu comme dû qu'à la remise du
  // MARDI : le garde-fou censé éviter d'arriver trop tôt ferait arriver un jour trop tard.
  it('« lundi 9 h » est dû à la remise du lundi matin', () => {
    const lundiMatin = new Date('2026-08-24T06:00:00.000Z');
    expect(isDueForDispatch(reminder(), lundiMatin, 'Africa/Lagos')).toBe(true);
  });

  it('mais pas à celle du dimanche', () => {
    const dimancheMatin = new Date('2026-08-23T06:00:00.000Z');
    expect(isDueForDispatch(reminder(), dimancheMatin, 'Africa/Lagos')).toBe(false);
  });

  it('un rappel en retard reste dû — on ne le perd jamais', () => {
    const mercredi = new Date('2026-08-26T06:00:00.000Z');
    expect(isDueForDispatch(reminder(), mercredi, 'Africa/Lagos')).toBe(true);
  });

  it('ignore ce qui a déjà été envoyé, échoué ou annulé', () => {
    const lundi = new Date('2026-08-24T06:00:00.000Z');
    for (const status of [
      NotificationStatus.Sent,
      NotificationStatus.Failed,
      NotificationStatus.Cancelled,
    ]) {
      expect(isDueForDispatch(reminder({ status }), lundi, 'Africa/Lagos'), status).toBe(false);
    }
  });

  it('ignore une prise FRAÎCHE — quelqu’un est en train de l’envoyer', () => {
    const lundi = new Date('2026-08-24T06:00:00.000Z');
    const enVol = reminder({
      status: NotificationStatus.Sending,
      updatedAt: '2026-08-24T05:59:00.000Z',
    });
    expect(isDueForDispatch(enVol, lundi, 'Africa/Lagos')).toBe(false);
  });

  /**
   * ⚠️ **LE MODE DE PANNE LE PLUS SILENCIEUX DE TOUT LE RÉPARTITEUR.**
   *
   * On prend AVANT d'envoyer, et l'état de prise interdit le doublon. Mais une fonction Vercel
   * peut être tuée entre les deux — `maxDuration`, redéploiement, incident. Sans reprise, le
   * rappel resterait `sending` pour toujours : aucune erreur, aucun log, personne prévenu.
   *
   * La grâce dépasse très largement `maxDuration` (60 s) : la raccourcir rouvrirait la course
   * qu'on vient de fermer, et le symptôme serait un doublon dans la boîte de quelqu'un.
   */
  it('REPREND une prise abandonnée au-delà de la grâce', () => {
    const now = new Date('2026-08-24T06:00:00.000Z');
    const abandonne = reminder({
      status: NotificationStatus.Sending,
      updatedAt: new Date(now.getTime() - STRANDED_CLAIM_MS - 1000).toISOString(),
    });
    expect(isDueForDispatch(abandonne, now, 'Africa/Lagos')).toBe(true);
    expect(isStrandedClaim(abandonne, now)).toBe(true);
  });

  it('la grâce dépasse très largement maxDuration — sinon on rouvre la course', () => {
    expect(STRANDED_CLAIM_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it('ignore une ligne sans date et une date illisible', () => {
    const lundi = new Date('2026-08-24T06:00:00.000Z');
    expect(isDueForDispatch(reminder({ scheduledAt: null }), lundi)).toBe(false);
    expect(isDueForDispatch(reminder({ scheduledAt: 'bientôt' }), lundi)).toBe(false);
  });

  it('juge sur le jour LOCAL, jamais sur le jour UTC', () => {
    // 2026-08-23T23:30Z, c'est déjà le 24 à Lagos (UTC+1). Comparer en UTC se tromperait de
    // journée une fois sur trois — et le symptôme serait un rappel arrivé la veille.
    const tardDimancheUtc = new Date('2026-08-23T23:30:00.000Z');
    expect(isDueForDispatch(reminder(), tardDimancheUtc, 'Africa/Lagos')).toBe(true);
    expect(isDueForDispatch(reminder(), tardDimancheUtc, 'UTC')).toBe(false);
  });
});

describe('le lot est borné, et le plus ancien passe en premier', () => {
  it('ordonne par date demandée', () => {
    const tard = reminder({ id: 'tard', scheduledAt: '2026-08-24T18:00:00.000Z' });
    const tot = reminder({ id: 'tot', scheduledAt: '2026-08-24T07:00:00.000Z' });
    const due = selectDueReminders([tard, tot], new Date('2026-08-24T06:00:00.000Z'));
    expect(due.map((n) => n.id)).toEqual(['tot', 'tard']);
  });

  it('ne traite jamais plus que le plafond — une rafale de courriels est irréversible', () => {
    const many = Array.from({ length: MAX_REMINDERS_PER_RUN + 10 }, (_, i) =>
      reminder({ id: `r${i}` }),
    );
    expect(selectDueReminders(many, new Date('2026-08-24T06:00:00.000Z'))).toHaveLength(
      MAX_REMINDERS_PER_RUN,
    );
  });
});

describe('le moment de REMISE est ce qu’on annonce, jamais le moment demandé', () => {
  it('« lundi 9 h » devient « lundi … au matin »', () => {
    const label = deliveryLabel('2026-08-24T09:00:00.000Z', new Date('2026-08-21T10:00:00.000Z'));
    expect(label).toMatch(/lundi/i);
    expect(label).toMatch(/au matin$/);
  });

  it('n’annonce AUCUNE heure — c’est toute la raison de ce champ', () => {
    // Le tool rendait « lundi 24 août 2026 à 09 h00 ». Le cron ne passe qu'une fois par jour,
    // à ±59 min : cette précision-là n'était tenue par aucune pièce du système.
    const label = deliveryLabel('2026-08-24T09:00:00.000Z', new Date('2026-08-21T10:00:00.000Z'));
    expect(label).not.toMatch(/\d{1,2}\s*[h:]\s*\d{2}/);
  });

  it('reporte au lendemain quand la remise du jour est déjà passée', () => {
    // Demandé pour ce soir : la remise du matin est derrière nous, on ne remonte pas le temps.
    const at = nextDeliveryAt('2026-08-21T20:00:00.000Z', new Date('2026-08-21T10:00:00.000Z'));
    expect(at?.toISOString()).toBe(`2026-08-22T0${REMINDER_DISPATCH_HOUR_UTC}:00:00.000Z`);
  });

  it('rend null sur une date illisible plutôt qu’une date inventée', () => {
    expect(nextDeliveryAt('demain', new Date())).toBeNull();
    expect(deliveryLabel('demain', new Date())).toBeNull();
  });
});

describe('le message remis se présente comme un rappel, pas comme une interruption', () => {
  it('nomme la demande et sa date', () => {
    const preamble = reminderPreamble('2026-08-24T09:00:00.000Z');
    expect(preamble).toMatch(/lundi/i);
    expect(preamble).toMatch(/demandé/i);
  });

  it('reste lisible sans date', () => {
    expect(reminderPreamble(null)).toMatch(/demandé/i);
    expect(reminderPreamble('n’importe quoi')).toMatch(/demandé/i);
  });

  it('est du mrkdwn Slack, jamais du markdown GitHub', () => {
    expect(reminderPreamble('2026-08-24T09:00:00.000Z')).not.toContain('**');
  });
});

describe('la planification est DÉRIVÉE, jamais recopiée', () => {
  it('l’heure du domaine s’accorde avec l’expression cron', () => {
    const [minute, hour] = REMINDER_DISPATCH_SCHEDULE.split(' ');
    expect(minute).toBe('0');
    expect(Number(hour)).toBe(REMINDER_DISPATCH_HOUR_UTC);
  });

  it('l’expression tourne au plus une fois par jour — le plan Hobby REFUSE le déploiement sinon', () => {
    const [minute, hour] = REMINDER_DISPATCH_SCHEDULE.split(' ');
    for (const field of [minute, hour]) {
      expect(field).not.toBe('*');
      expect(field).not.toContain('/');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LA REMISE ELLE-MÊME
// ════════════════════════════════════════════════════════════════════════════

interface Mocks {
  notifications: InMemoryNotificationRepository;
  employees: { findById: ReturnType<typeof vi.fn> };
  email: { sendEmail: ReturnType<typeof vi.fn> };
  chat: { sendMessage: ReturnType<typeof vi.fn> };
  slackWorkspace: { findUserByEmail: ReturnType<typeof vi.fn> };
  now: () => Date;
}

function makeDeps(overrides: Partial<Mocks> = {}): Mocks {
  return {
    notifications: new InMemoryNotificationRepository(),
    employees: {
      findById: vi.fn().mockResolvedValue({
        id: BASE.recipientId,
        email: 'karyl@kissohq.com',
        firstName: 'Karyl',
        lastName: 'SOUMAILA',
      }),
    },
    email: { sendEmail: vi.fn().mockResolvedValue(undefined) },
    chat: { sendMessage: vi.fn().mockResolvedValue({ channel: 'D1' }) },
    slackWorkspace: { findUserByEmail: vi.fn().mockResolvedValue({ id: 'U1' }) },
    now: () => new Date('2026-08-24T06:00:00.000Z'),
    ...overrides,
  };
}

const run = (deps: Mocks) => dispatchDueReminders(deps as unknown as DispatchDeps);

describe('la remise quotidienne', () => {
  it('envoie un rappel dû et le marque envoyé', async () => {
    const deps = makeDeps();
    const due = reminder({ id: 'due' });
    await deps.notifications.save(due);

    const report = await run(deps);

    expect(report).toMatchObject({ due: 1, sent: 1, failed: 0, skipped: 0 });
    expect(deps.email.sendEmail).toHaveBeenCalledTimes(1);
    expect((await deps.notifications.findById('due'))?.status).toBe(NotificationStatus.Sent);
  });

  it('le message porte la mise en contexte ET le corps enregistré', async () => {
    const deps = makeDeps();
    await deps.notifications.save(reminder({ id: 'due' }));

    await run(deps);

    const [, subject, body] = deps.email.sendEmail.mock.calls[0]!;
    expect(subject).toBe(BASE.subject);
    expect(JSON.stringify(body)).toContain('demandé');
    expect(JSON.stringify(body)).toContain('guidelines');
  });

  it('ne touche PAS un rappel dont le jour n’est pas venu', async () => {
    const deps = makeDeps({ now: () => new Date('2026-08-22T06:00:00.000Z') });
    await deps.notifications.save(reminder({ id: 'plus-tard' }));

    const report = await run(deps);

    expect(report.due).toBe(0);
    expect(deps.email.sendEmail).not.toHaveBeenCalled();
    expect((await deps.notifications.findById('plus-tard'))?.status).toBe(
      NotificationStatus.Scheduled,
    );
  });

  /**
   * ⚠️ LE CONTRÔLE LE PLUS IMPORTANT DU FICHIER.
   *
   * Deux exécutions du cron — ou un rejeu Vercel — ne doivent pas remettre deux fois le même
   * rappel. C'est le contrat de `clear()` sur les emails d'entretien, transposé : la PRISE est
   * l'écriture, et elle rend un compte.
   */
  it('deux exécutions n’envoient qu’UNE fois', async () => {
    const deps = makeDeps();
    await deps.notifications.save(reminder({ id: 'due' }));

    await run(deps);
    await run(deps);

    expect(deps.email.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('une prise déjà tenue par quelqu’un d’autre n’envoie rien', async () => {
    const deps = makeDeps();
    await deps.notifications.save(reminder({ id: 'due' }));
    vi.spyOn(deps.notifications, 'claimForDispatch').mockResolvedValue(false);

    const report = await run(deps);

    expect(report).toMatchObject({ sent: 0, skipped: 1 });
    expect(deps.email.sendEmail).not.toHaveBeenCalled();
  });

  it('sur échec de TRANSPORT, la prise est rendue — la remise de demain rattrapera', async () => {
    const deps = makeDeps({
      email: { sendEmail: vi.fn().mockRejectedValue(new Error('SMTP timeout')) },
    });
    await deps.notifications.save(reminder({ id: 'due' }));

    const report = await run(deps);

    expect(report).toMatchObject({ sent: 0, skipped: 1 });
    expect(report.reasons.transport_failed).toBe(1);
    expect((await deps.notifications.findById('due'))?.status).toBe(NotificationStatus.Scheduled);
  });

  it('un destinataire disparu est un échec DÉFINITIF, pas une reprise éternelle', async () => {
    // Rien ne fera revenir le dossier d'ici demain. Rendre la prise ferait repartir le même
    // rappel en échec tous les matins, indéfiniment.
    const deps = makeDeps({ employees: { findById: vi.fn().mockResolvedValue(null) } });
    await deps.notifications.save(reminder({ id: 'due' }));

    const report = await run(deps);

    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(report.reasons.recipient_not_found).toBe(1);
    expect((await deps.notifications.findById('due'))?.status).toBe(NotificationStatus.Failed);
  });

  it('une base indisponible REND la prise — c’est réparable, contrairement à un dossier absent', async () => {
    const deps = makeDeps({
      employees: { findById: vi.fn().mockRejectedValue(new Error('turso down')) },
    });
    await deps.notifications.save(reminder({ id: 'due' }));

    const report = await run(deps);

    expect(report.reasons.recipient_lookup_failed).toBe(1);
    expect((await deps.notifications.findById('due'))?.status).toBe(NotificationStatus.Scheduled);
  });

  it('remet par Slack quand c’est le canal enregistré', async () => {
    const deps = makeDeps();
    await deps.notifications.save(reminder({ id: 'due', channel: NotificationChannel.Slack }));

    await run(deps);

    expect(deps.chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.email.sendEmail).not.toHaveBeenCalled();
  });

  it('ne rédige RIEN : aucun appel de modèle sur ce chemin', async () => {
    // Le sujet et le corps ont été relus par la personne au moment de la demande. Les
    // refabriquer reviendrait à envoyer un texte que personne n'a vu — et à payer un
    // aller-retour par rappel sur un budget qui se compte à la journée.
    const deps = makeDeps();
    await deps.notifications.save(reminder({ id: 'due' }));

    await run(deps);

    const [, subject] = deps.email.sendEmail.mock.calls[0]!;
    expect(subject).toBe(BASE.subject);
  });
});

describe('la route du cron', () => {
  it('REFUSE quand CRON_SECRET n’est pas configuré — jamais une primitive publique', async () => {
    const { authorizeCron } = await import('../../../src/api/reminders-dispatch.route');
    expect(authorizeCron('Bearer x', undefined)).toEqual({
      ok: false,
      status: 503,
      reason: 'cron_secret_not_configured',
    });
  });

  it('refuse un en-tête absent ou faux', async () => {
    const { authorizeCron } = await import('../../../src/api/reminders-dispatch.route');
    expect(authorizeCron(undefined, 's3cret')).toMatchObject({ ok: false, status: 401 });
    expect(authorizeCron('Bearer autre', 's3cret')).toMatchObject({ ok: false, status: 401 });
    expect(authorizeCron('s3cret', 's3cret')).toMatchObject({ ok: false, status: 401 });
  });

  it('accepte l’en-tête que Vercel pose lui-même', () => {
    return import('../../../src/api/reminders-dispatch.route').then(({ authorizeCron }) => {
      expect(authorizeCron('Bearer s3cret', 's3cret')).toEqual({ ok: true });
    });
  });

  it('n’est PAS montée sous /api — le préfixe est réservé, et l’échec serait au démarrage', () => {
    expect(REMINDER_DISPATCH_PATH.startsWith('/api')).toBe(false);
  });
});

describe('une prise abandonnée est reprise par la remise suivante', () => {
  it('le rappel repart, il n’est pas perdu', async () => {
    const deps = makeDeps();
    // Prise laissée en vol par une invocation tuée il y a huit heures.
    await deps.notifications.save(
      reminder({
        id: 'abandonne',
        status: NotificationStatus.Sending,
        updatedAt: new Date(Date.parse('2026-08-23T22:00:00.000Z')).toISOString(),
      }),
    );

    const report = await run(deps);

    expect(report).toMatchObject({ due: 1, sent: 1 });
    expect(deps.email.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('mais une prise FRAÎCHE est laissée tranquille — pas de doublon', async () => {
    const deps = makeDeps();
    await deps.notifications.save(
      reminder({
        id: 'en-vol',
        status: NotificationStatus.Sending,
        updatedAt: '2026-08-24T05:59:30.000Z',
      }),
    );

    const report = await run(deps);

    expect(report.due).toBe(0);
    expect(deps.email.sendEmail).not.toHaveBeenCalled();
  });
});
