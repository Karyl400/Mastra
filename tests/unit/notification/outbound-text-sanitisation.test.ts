/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE FILTRE DE SORTIE AVAIT DEUX TROUS, ET LE CRON EN A OUVERT UN TROISIÈME
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le 2026-08-20, `sendNotification.body` a été branché sur `sanitizeNotificationBody` —
 * marqueurs internes retirés, URL hors `ALLOWED_LINK_DOMAINS` supprimées. Deux chemins
 * voisins ont été laissés en arrière, et l'audit du 2026-08-21 les a trouvés :
 *
 * 1. **`sendNotification.subject`** part BRUT sur les deux transports, à deux caractères du
 *    `body` qui, lui, est filtré. Le sujet est la partie la plus visible d'un email et la
 *    ligne en gras d'un message Slack — et son `.describe()` ORDONNE au modèle de le rédiger.
 *
 * 2. **`scheduleReminder`** ne filtre RIEN, ni sujet ni corps, et le cron du 2026-08-21 les
 *    expédie le lendemain matin.
 *
 * ⚠️ **Le second est le plus grave, et sa cause est une leçon que ce dépôt connaît déjà.**
 * Tant qu'« aucun automate ne reprenait le statut `Scheduled` », rien ne partait : le défaut
 * DORMAIT. Allumer l'ordonnanceur l'a réveillé — exactement comme il a fallu déplacer
 * `onlyNonDeliveringTools` le même jour. Le dépôt avait énoncé la règle pour les DÉTECTEURS
 * (« un détecteur encode le câblage ; quand le câblage bouge, il devient faux dans l'autre
 * sens ») sans voir qu'elle vaut aussi pour les ASSAINISSEURS.
 *
 * Et c'est le seul chemin sortant du produit sur lequel PERSONNE N'EST PRÉSENT au moment de
 * l'envoi : un rappel est rédigé un jour et remis le lendemain, sans relecture. Un lien de
 * hameçonnage y a plus de chances d'aboutir que partout ailleurs.
 *
 * ⚠️ **On filtre à l'ÉCRITURE *et* à la REMISE**, et ce n'est pas une redondance — c'est le
 * même raisonnement que `generateDocument`, qui filtre au seuil du rendu ET dans le tool :
 *   - à l'écriture, pour que la base ne porte jamais le marqueur (un futur lecteur le
 *     ressortirait tel quel — c'est ce que fait déjà `getNotificationHistory`) ;
 *   - à la remise, parce qu'une ligne peut avoir été écrite AVANT ce correctif.
 * La production porte aujourd'hui des rappels enregistrés sans filtre : sans le second
 * passage, ce correctif ne protégerait que les rappels futurs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  sanitizeNotificationSubject,
  NOTIFICATION_SUBJECT_PLACEHOLDER,
} from '../../../src/shared/security/agent-output';
import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { dispatchDueReminders } from '../../../src/features/notification/application/services/dispatch-due-reminders';
import { createNotification } from '../../../src/features/notification/domain/entities/notification';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../src/shared/types';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';

const EMPLOYEE_ID = '123e4567-e89b-12d3-a456-426614174000';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

describe('sanitizeNotificationSubject', () => {
  it('retire une URL hors liste blanche et garde le reste', () => {
    const { text, strippedUrls } = sanitizeNotificationSubject(
      'Action requise : https://evil.tld/reset',
    );

    expect(text).not.toContain('evil.tld');
    expect(text).toContain('Action requise');
    expect(strippedUrls).toEqual(['evil.tld']);
  });

  it('laisse passer un lien Slack légitime', () => {
    const { text, strippedUrls } = sanitizeNotificationSubject('Voir https://kissohq.slack.com/x');

    expect(text).toContain('https://kissohq.slack.com/x');
    expect(strippedUrls).toEqual([]);
  });

  it('APLATIT les sauts de ligne — un sujet multiligne est une injection d’en-tête', () => {
    // Contrat PROPRE au sujet, et c'est pourquoi ce n'est pas `sanitizeNotificationBody` qu'on
    // réutilise tel quel : un corps a le droit d'avoir des paragraphes, un sujet non. `\r\n`
    // dans un sujet est la primitive classique d'injection d'en-tête SMTP. Nodemailer s'en
    // protège, mais on ne délègue pas à un transport une garantie qu'on peut tenir soi-même —
    // et le second transport, Slack, n'a jamais entendu parler de cette règle.
    const { text } = sanitizeNotificationSubject('Bonjour\r\nBcc: evil@example.com\nSuite');

    expect(text).not.toContain('\n');
    expect(text).not.toContain('\r');
    expect(text).toContain('Bonjour');
  });

  it('rend un sujet de repli COURT quand tout a été retiré', () => {
    // Le placeholder du corps est une phrase entière ; en faire un sujet donnerait une ligne
    // d'objet absurde. Deux fonctions, deux replis.
    const { text } = sanitizeNotificationSubject('   ');

    expect(text).toBe(NOTIFICATION_SUBJECT_PLACEHOLDER);
    expect(NOTIFICATION_SUBJECT_PLACEHOLDER.length).toBeLessThan(60);
  });

  it('borne la longueur — le schéma autorise 200 caractères, un en-tête pas toujours', () => {
    const { text } = sanitizeNotificationSubject('a'.repeat(400));

    expect(text.length).toBeLessThanOrEqual(200);
  });
});

describe('scheduleReminder — ce qui est ENREGISTRÉ est déjà propre', () => {
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

  async function schedule(subject: string, body: string) {
    await makeScheduleReminder(notificationRepo, employeeRepo).execute!(
      { recipientId: EMPLOYEE_ID, subject, body, scheduledAt: FUTURE } as never,
      {} as never,
    );
    const [stored] = await notificationRepo.findByRecipient(EMPLOYEE_ID);
    return stored!;
  }

  it("ne stocke pas l'URL hors liste blanche que le modèle a produite", async () => {
    const stored = await schedule(
      'Rappel : réinitialise ton accès',
      'Va sur https://evil.tld/reset avant vendredi.',
    );

    expect(stored.body).not.toContain('evil.tld');
    expect(stored.body).toContain('avant vendredi');
  });

  it('ne stocke pas un marqueur interne dans le sujet', async () => {
    const stored = await schedule('Note KISSO-AGENT-v3 interne', 'Bonjour.');

    expect(stored.subject).not.toContain('KISSO-AGENT-v3');
  });

  it('garde intact un rappel parfaitement légitime', async () => {
    // Le contrôle anti-faux-positif : un assainisseur qui abîme le cas nominal serait pire
    // que le défaut qu'il corrige.
    const stored = await schedule('Signer le contrat', 'Merci de signer avant vendredi.');

    expect(stored.subject).toBe('Signer le contrat');
    expect(stored.body).toBe('Merci de signer avant vendredi.');
  });
});

/**
 * ⚠️ **LE SECOND PASSAGE PROTÈGE CE QUI EST DÉJÀ EN BASE.**
 *
 * La production porte des rappels enregistrés avant le correctif du 2026-08-21, et le cron est
 * le seul code qui les relira jamais. Un correctif posé uniquement à l'écriture n'aurait
 * protégé que l'avenir — or ce sont précisément les lignes anciennes qui vont partir demain
 * matin, sans que personne ne les relise.
 *
 * Le harnais est celui de `reminder-dispatch.test.ts`, délibérément : deux doublures du même
 * service finissent par ne plus décrire le même service.
 */
describe('dispatchDueReminders — ce qui est REMIS est propre, même écrit avant le correctif', () => {
  const NOW = new Date('2026-08-24T06:00:00.000Z');
  const DUE = '2026-08-24T09:00:00.000Z';

  async function deliver(subject: string, body: string) {
    const notifications = new InMemoryNotificationRepository();
    await notifications.save({
      ...createNotification({
        id: 'rem-1',
        recipientId: EMPLOYEE_ID,
        recipientType: RecipientType.Employee,
        channel: NotificationChannel.Slack,
        subject,
        body,
      }),
      status: NotificationStatus.Scheduled,
      scheduledAt: DUE,
    });

    const chat = { sendMessage: vi.fn().mockResolvedValue({ channel: 'D1' }) };
    const deps = {
      notifications,
      employees: {
        findById: vi.fn().mockResolvedValue({
          id: EMPLOYEE_ID,
          email: 'jean.dupont@kisso.com',
          firstName: 'Jean',
          lastName: 'Dupont',
        }),
      },
      email: { sendEmail: vi.fn().mockResolvedValue(undefined) },
      chat,
      slackWorkspace: { findUserByEmail: vi.fn().mockResolvedValue({ id: 'U1' }) },
      now: () => NOW,
    };

    const report = await dispatchDueReminders(deps as never);
    return { report, chat };
  }

  it("retire l'URL hors liste blanche d'un rappel enregistré AVANT le correctif", async () => {
    const { report, chat } = await deliver(
      'Réinitialise ton accès',
      'Va sur https://evil.tld/reset avant vendredi.',
    );

    expect(report.sent).toBe(1);
    const text = chat.sendMessage.mock.calls[0]![1] as string;
    expect(text).not.toContain('evil.tld');
    expect(text).toContain('avant vendredi');
  });

  it('laisse un rappel légitime rigoureusement intact', async () => {
    // Anti-faux-positif : un second passage qui abîmerait le cas nominal serait pire que le
    // défaut. L'opération doit être IDEMPOTENTE — un texte déjà propre en ressort identique.
    const { report, chat } = await deliver('Signer le contrat', 'Merci de signer avant vendredi.');

    expect(report.sent).toBe(1);
    const text = chat.sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain('*Signer le contrat*');
    expect(text).toContain('Merci de signer avant vendredi.');
  });
});
