/**
 * `scheduleReminder` — un puits sans fond, rendu HONNÊTE, puis rendu UTILE.
 *
 * Constat (campagne du 2026-08-11) : le statut `Scheduled` posé par ce tool n'était lu NULLE
 * PART — aucun cron, aucun poller, et `findPending()` n'avait aucun site d'appel. Le tool a
 * d'abord été rendu honnête : il ENREGISTRE, il n'expédie pas, et il refuse bruyamment ce qui
 * ne peut pas être vrai (destinataire inconnu, date passée).
 *
 * ⚠️ **LA DÉCISION « ON NE CONSTRUIT PAS L'ORDONNANCEUR » A ÉTÉ RENVERSÉE LE 2026-08-21**, sur
 * le verdict du propriétaire : « ce n'est pas le but d'un rappel ». Un rappel dont il faut se
 * souvenir n'est pas un rappel — l'honnêteté avait remplacé le mensonge par une inutilité, ce
 * qui était un progrès et pas une fin.
 *
 * Ce qui manquait n'était pas du code mais une HORLOGE EXTÉRIEURE : dans un serverless, rien
 * ne s'exécute tant que personne ne frappe à la porte. Un cron Vercel quotidien appelle
 * désormais `/internal/reminders/dispatch`, et `willBeSentAutomatically: true` est enfin vrai.
 *
 * ⚠️ **CE QUI RESTE INTERDIT : ANNONCER UNE HEURE.** Le plan Hobby ne permet qu'un passage par
 * jour, à ±59 min. Le tool ne rend donc plus la date DEMANDÉE mais le moment de REMISE, et
 * sans heure — le modèle ne peut pas répéter une précision qu'on ne lui donne pas.
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
    it("dit qu'il a ENREGISTRÉ le rappel, et que la remise aura bien lieu", async () => {
      const result = (await tool().execute!(validInput as never, {} as never)) as Record<
        string,
        unknown
      >;

      expect(result.stored).toBe(true);
      expect(result.willBeSentAutomatically).toBe(true);
      // Le corps rédigé par le modèle ne lui est pas refacturé.
      expect(JSON.stringify(result)).not.toContain('signer ton contrat');
    });

    it('ne rend PAS la date demandée — seulement le moment de remise, sans heure', async () => {
      // ⚠️ C'est le cœur du garde-fou. Le tool rendait `scheduledAt` brut et un
      // `scheduledLabel` portant l'heure : deux occasions, pour le modèle, d'annoncer une
      // précision que le cron quotidien ne tient pas.
      const result = (await tool().execute!(validInput as never, {} as never)) as Record<
        string,
        unknown
      >;

      expect(result.scheduledAt).toBeUndefined();
      expect(result.deliveredOn).toMatch(/au matin$/);
      expect(String(result.deliveredOn)).not.toMatch(/\d{1,2}\s*[h:]\s*\d{2}/);
    });

    it('sa description dit la remise, et ne dit pas « planifié »', () => {
      // « planifié » promet une heure ; « remis le matin » dit ce qui a réellement lieu. Le mot
      // que lit le modèle est celui qu'il répétera — relevé en production le 2026-08-19.
      const description = String(tool().description);
      expect(description).toMatch(/enregistr/i);
      expect(description).toMatch(/matin/i);
      expect(description).not.toMatch(/planifie\b|planifié\b/i);
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
    )) as { deliveredOn: string; willBeSentAutomatically: boolean };

    // ⚠️ Le jour reste le contrôle qui compte : c'est LUI que le modèle avait faux
    // (« lundi prochain » rendait « samedi 22 août »), et c'est LUI que la remise respecte.
    // L'heure et l'offset ont disparu du libellé — non par oubli, mais parce qu'aucune pièce
    // de ce système ne les tient. Voir `reminder-dispatch.ts`.
    expect(out.deliveredOn).toContain('samedi');
    expect(out.deliveredOn).not.toContain('lundi');
    expect(out.deliveredOn).toContain('2026');
    expect(out.deliveredOn).not.toMatch(/UTC/);
  });

  it('le rappel est bien ENREGISTRÉ en état reprenable par la remise quotidienne', async () => {
    // ⚠️ Le lien entre le tool et le cron n'est pas un appel mais un ÉTAT : `Scheduled`. Si le
    // tool écrivait autre chose, `findPending()` ne le verrait jamais et le rappel dormirait
    // pour toujours — le défaut d'origine sous une autre forme, et tout aussi silencieux.
    const repo = notificationRepoOf();
    const tool = makeScheduleReminder(repo, await employeeRepoOf());

    const out = (await tool.execute!(
      {
        recipientId: EMPLOYEE_ID,
        subject: 'x',
        body: 'y',
        scheduledAt: FUTURE,
      } as never,
      {} as never,
    )) as { willBeSentAutomatically: boolean };

    expect(out.willBeSentAutomatically).toBe(true);
    expect(await repo.findPending()).toHaveLength(1);
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
