/**
 * `scheduleReminder` — un puits sans fond rendu HONNÊTE.
 *
 * Constat (campagne du 2026-08-11) : le statut `Scheduled` posé par ce tool n'est lu
 * NULLE PART — aucun cron, aucun poller, et `findPending()` n'a aucun site d'appel et
 * filtre de toute façon sur `Pending`. Le tool ne vérifiait ni l'existence du
 * destinataire (contrairement à `sendNotification`) ni que la date était future.
 * Résultat : l'agent promettait un envoi qui n'aurait jamais lieu.
 *
 * Décision : on ne construit PAS l'ordonnanceur (chantier d'infrastructure). On rend
 * le tool honnête — il ENREGISTRE un rappel, il ne l'expédie pas — et on refuse
 * bruyamment ce qui ne peut pas être vrai (destinataire inconnu, date passée).
 *
 * C'est la même règle que partout ailleurs dans ce dépôt : un mensonge silencieux est
 * pire qu'une panne bruyante.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';

const EMPLOYEE_ID = '123e4567-e89b-12d3-a456-426614174000';
const UNKNOWN_ID = '999e4567-e89b-12d3-a456-4266141749ff';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

describe('scheduleReminder', () => {
  let notificationRepo: InMemoryNotificationRepository;
  let employeeRepo: InMemoryEmployeeRepository;

  beforeEach(async () => {
    notificationRepo = new InMemoryNotificationRepository();
    employeeRepo = new InMemoryEmployeeRepository();
    await employeeRepo.save(
      createEmployee({
        id: EMPLOYEE_ID,
        firstName: 'Jean',
        lastName: 'Dupont',
        email: 'jean.dupont@kisso.com',
        department: 'Engineering',
        position: 'Backend Developer',
        startDate: '2026-01-05',
        managerId: null,
      }),
    );
  });

  function tool() {
    return makeScheduleReminder(notificationRepo, employeeRepo);
  }

  const validInput = {
    recipientId: EMPLOYEE_ID,
    subject: 'Signer le contrat',
    body: 'Merci de signer ton contrat avant vendredi.',
    scheduledAt: FUTURE,
  };

  describe('honnêteté du verdict', () => {
    it("dit qu'il a ENREGISTRÉ le rappel et qu'aucun envoi automatique n'aura lieu", async () => {
      const result = (await tool().execute!(validInput as never, {} as never)) as Record<
        string,
        unknown
      >;

      expect(result.stored).toBe(true);
      expect(result.willBeSentAutomatically).toBe(false);
      expect(result.scheduledAt).toBe(FUTURE);
      // Le corps rédigé par le modèle ne lui est pas refacturé.
      expect(JSON.stringify(result)).not.toContain('signer ton contrat');
    });

    it('ne promet aucun envoi dans sa description', () => {
      const description = String(tool().description);
      expect(description).toMatch(/enregistr/i);
      expect(description).not.toMatch(/planifie\b|envoie|expédi/i);
    });

    it('persiste bien le rappel', async () => {
      await tool().execute!(validInput as never, {} as never);
      expect(await notificationRepo.findByRecipient(EMPLOYEE_ID)).toHaveLength(1);
    });
  });

  describe('refus bruyants', () => {
    it('REFUSE une date déjà passée, et n enregistre rien', async () => {
      await expect(
        tool().execute!({ ...validInput, scheduledAt: PAST } as never, {} as never),
      ).rejects.toThrow(/futur|future/i);

      expect(await notificationRepo.findByRecipient(EMPLOYEE_ID)).toHaveLength(0);
    });

    it('REFUSE une date illisible', async () => {
      await expect(
        tool().execute!({ ...validInput, scheduledAt: 'demain matin' } as never, {} as never),
      ).rejects.toThrow();

      expect(await notificationRepo.findByRecipient(EMPLOYEE_ID)).toHaveLength(0);
    });

    it('REFUSE un destinataire absent de l annuaire, comme sendNotification', async () => {
      await expect(
        tool().execute!({ ...validInput, recipientId: UNKNOWN_ID } as never, {} as never),
      ).rejects.toThrow(/introuvable|not found/i);

      expect(await notificationRepo.findByRecipient(UNKNOWN_ID)).toHaveLength(0);
    });
  });

  describe('schéma', () => {
    it('ne demande au modèle que ce qu il ne peut pas déduire', () => {
      const shape = (tool().inputSchema as never as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape).sort()).toEqual(
        ['body', 'channel', 'recipientId', 'recipientType', 'scheduledAt', 'subject'].sort(),
      );
    });
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE JOUR DE LA SEMAINE EST CALCULÉ, PLUS ÉCRIT PAR LE MODÈLE — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Réponse littérale relevée en production ce jour-là, sur « planifie un rappel … avant
 * lundi » :
 *
 *     « Rappel planifié : … à 09 h 00 le lundi 22 août 2026 »
 *
 * Le 22 août 2026 est un SAMEDI, et « avant lundi » désignait le 24. Vérifié en base :
 * `scheduled_at` valait bien `2026-08-22T09:00:00Z`. Le libellé était écrit par le MODÈLE, à
 * côté d'une date qu'il avait lui-même calculée, et rien ne confrontait les deux.
 *
 * `recruitmentAgent` ne peut pas commettre cette faute — au même moment il a produit
 * « mardi 15 septembre 2026 », exact — parce que son libellé vient d'un gabarit. C'est la
 * doctrine du dépôt : une prose se produit, un fait se calcule.
 */
describe('scheduleReminder — le libellé de date vient du CODE', () => {
  it('rend le jour de la semaine EXACT, celui que le modèle avait faux', async () => {
    const tool = makeScheduleReminder(notificationRepoOf(), await employeeRepoOf());

    const out = (await tool.execute!(
      {
        recipientId: EMPLOYEE_ID,
        subject: 'Relire le guide',
        body: 'Merci de relire le guide.',
        scheduledAt: '2026-08-22T09:00:00.000Z',
      } as never,
      {} as never,
    )) as { scheduledLabel: string; willBeSentAutomatically: boolean };

    expect(out.scheduledLabel).toContain('samedi');
    expect(out.scheduledLabel).not.toContain('lundi');
    expect(out.scheduledLabel).toContain('2026');
    // L'offset est imprimé : c'est ce qui rend l'heure vérifiable au lieu d'implicite.
    expect(out.scheduledLabel).toMatch(/UTC[+-]\d{2}:\d{2}|UTC/);
  });

  it('n’a pas cessé de dire qu’aucun automate n’enverra le rappel', async () => {
    // Le libellé rend la date lisible ; il ne doit rien promettre de plus. Le verdict qui
    // empêche la promesse reste `willBeSentAutomatically: false`.
    const tool = makeScheduleReminder(notificationRepoOf(), await employeeRepoOf());

    const out = (await tool.execute!(
      {
        recipientId: EMPLOYEE_ID,
        subject: 'x',
        body: 'y',
        scheduledAt: FUTURE,
      } as never,
      {} as never,
    )) as { willBeSentAutomatically: boolean };

    expect(out.willBeSentAutomatically).toBe(false);
  });
});

function notificationRepoOf() {
  return new InMemoryNotificationRepository();
}

async function employeeRepoOf() {
  const repo = new InMemoryEmployeeRepository();
  await repo.save(
    createEmployee({
      id: EMPLOYEE_ID,
      firstName: 'Jean',
      lastName: 'Dupont',
      email: 'jean.dupont@kisso.com',
      department: 'Engineering',
      position: 'Backend Developer',
      startDate: '2026-01-05',
    }),
  );
  return repo;
}
