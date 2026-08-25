import { describe, it, expect, beforeEach } from 'vitest';

import { type SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler, makeDirectoryDouble } from '../../helpers/slack-handler';
import { InMemoryNotificationRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-notification.repository';
import type { Notification } from '../../../src/features/notification/domain/entities/notification';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../src/shared/types';
import {
  NO_REMINDER_TO_CANCEL_REPLY,
  REMINDER_ALREADY_SENT_REPLY,
} from '../../../src/shared/cancel-reminder';
import { isAnsweredWithoutModel } from '../../../src/features/notification/domain/services/deterministic-replies';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE DOUZIÈME COURT-CIRCUIT — ET LE PREMIER GESTE RÉVERSIBLE DU PRODUIT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Marcel savait poser un rappel depuis le 2026-08-21 et n'a JAMAIS su le reprendre. La seule
 * sortie offerte était « repasse me le demander » — mot pour mot le verdict que le propriétaire
 * avait déjà rejeté à propos des rappels eux-mêmes : *« ce n'est pas le but d'un rappel »*. Un
 * geste qu'on ne peut pas défaire n'est pas un geste sûr, c'est un geste qu'on hésite à faire.
 *
 * ⚠️ **POURQUOI UN COURT-CIRCUIT ET PAS UN OUTIL** — deux raisons, la seconde décisive :
 *
 *   1. Un outil est un schéma réémis à CHAQUE aller-retour de l'agent qui le porte, et
 *      `notificationAgent` en porte déjà sept. Le court-circuit coûte ZÉRO token.
 *   2. **Le modèle ne PEUT PAS désigner le rappel.** `getNotificationHistory` ne rend aucun
 *      `id` (à dessein), et la mémoire conversationnelle ne stocke que du TEXTE — donc l'`id`
 *      rendu par `scheduleReminder` n'est plus dans la fenêtre au message suivant. C'est le mur
 *      exact qui a fait passer `generateDocument.revises` d'un UUID à un booléen. Un outil
 *      `cancelReminder(id)` serait soit inutilisable, soit une invitation à inventer un
 *      identifiant — et la cible d'un identifiant inventé, c'est le rappel de quelqu'un d'autre.
 *
 * ⚠️ **LA PORTÉE EST STRUCTURELLE, PAS FILTRÉE.** On part du dossier du DEMANDEUR, et
 * `cancelIfPending` porte `recipient_id` dans sa clause : il n'existe aucun chemin par lequel
 * l'annulation touche le rappel d'un tiers. Un filtre côté appelant est un filtre qu'on peut
 * oublier de rappeler.
 *
 * L'agent par défaut de ce harnais LÈVE. Chaque test de ce fichier prouve donc aussi, sans
 * l'écrire, qu'aucun modèle n'est appelé.
 */

const HUMAN = 'U0BJBDGTJUD';
const EMPLOYEE = '11111111-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';

const NOW = new Date('2026-08-25T12:00:00.000Z');

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.001400',
});

function reminder(over: Partial<Notification> = {}): Notification {
  return {
    id: 'r-jeudi',
    recipientId: EMPLOYEE,
    recipientType: RecipientType.Employee,
    channel: NotificationChannel.Email,
    subject: 'Rappel : relire le compte rendu',
    body: 'Relire le compte rendu.',
    status: NotificationStatus.Scheduled,
    scheduledAt: '2026-08-27T09:00:00+01:00',
    sentAt: null,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...over,
  } as Notification;
}

const GUIDELINES = reminder({
  id: 'r-lundi',
  subject: 'Rappel : relire les guidelines',
  scheduledAt: '2026-08-31T09:00:00+01:00',
});

let repo: InMemoryNotificationRepository;

function makeHarness() {
  return makeSlackHandler({
    directoryRepository: makeDirectoryDouble({ employeeId: EMPLOYEE, realName: 'Karyl S' }),
    notificationRepository: repo,
    now: () => NOW,
  });
}

async function say(text: string): Promise<string> {
  const harness = makeHarness();
  await harness.handler.handleMessage(dm(text));
  return [...harness.postedTexts(), ...harness.updatedTexts()].join('\n');
}

beforeEach(() => {
  repo = new InMemoryNotificationRepository();
});

describe('un seul rappel en attente', () => {
  beforeEach(async () => {
    await repo.save(reminder());
  });

  it('l’annule et NOMME ce qui a été annulé', async () => {
    const said = await say('annule le rappel');

    expect(said).toContain('relire le compte rendu');
    expect((await repo.findById('r-jeudi'))?.status).toBe(NotificationStatus.Cancelled);
  });

  it('le retire de findPending — le cron ne le verra plus', async () => {
    await say('annule le rappel');

    expect(await repo.findPending()).toHaveLength(0);
  });

  it('n’appelle AUCUN modèle', async () => {
    const harness = makeHarness();

    // L'agent par défaut lève : si le message partait chez lui, ceci rejetterait.
    await expect(harness.handler.handleMessage(dm('annule le rappel'))).resolves.toBeUndefined();
  });
});

describe('deux rappels en attente — on ne devine pas', () => {
  beforeEach(async () => {
    await repo.save(reminder());
    await repo.save(GUIDELINES);
  });

  it('sans désignation, il DEMANDE lequel et n’annule rien', async () => {
    const said = await say('annule le rappel');

    expect(said).toContain('relire le compte rendu');
    expect(said).toContain('relire les guidelines');
    expect(await repo.findPending()).toHaveLength(2);
  });

  it('la question donne une SORTIE — un mot suffit à trancher', async () => {
    // ⚠️ Sans cela, « lequel ? » serait une boucle sans sortie : la réponse « celui de jeudi »
    // redéclenche le même court-circuit et reposerait la même question.
    const said = await say('annule le rappel de jeudi');

    expect(said).toContain('relire le compte rendu');
    expect((await repo.findById('r-jeudi'))?.status).toBe(NotificationStatus.Cancelled);
    expect((await repo.findById('r-lundi'))?.status).toBe(NotificationStatus.Scheduled);
  });

  it('« tous » les annule d’un coup, et dit combien', async () => {
    const said = await say('annule tous mes rappels');

    expect(said).toContain('2 rappels');
    expect(await repo.findPending()).toHaveLength(0);
  });
});

describe('les cas où il n’y a rien à annuler', () => {
  it('aucun rappel en attente — il le dit, sans inventer', async () => {
    expect(await say('annule le rappel')).toContain(NO_REMINDER_TO_CANCEL_REPLY);
  });

  it('un rappel DÉJÀ EN COURS de remise ne s’arrête plus — et il l’avoue', async () => {
    // Le cron tourne à 6 h. Prétendre l'avoir annulé alors qu'il est parti serait la famille de
    // mensonge que tout ce dépôt traque : `emailSent: false` sous `status: 'success'`.
    await repo.save(reminder({ status: NotificationStatus.Sending }));

    const said = await say('annule le rappel');

    expect(said).toContain(REMINDER_ALREADY_SENT_REPLY);
    expect((await repo.findById('r-jeudi'))?.status).toBe(NotificationStatus.Sending);
  });

  it('un rappel DÉJÀ ENVOYÉ n’est pas proposé à l’annulation', async () => {
    await repo.save(reminder({ status: NotificationStatus.Sent }));

    expect(await say('annule le rappel')).toContain(NO_REMINDER_TO_CANCEL_REPLY);
  });
});

describe('la portée est celle du DEMANDEUR, et rien d’autre', () => {
  it('le rappel d’un tiers n’est ni proposé, ni touché', async () => {
    await repo.save(reminder({ recipientId: SOMEONE_ELSE }));

    const said = await say('annule le rappel');

    expect(said).toContain(NO_REMINDER_TO_CANCEL_REPLY);
    expect((await repo.findById('r-jeudi'))?.status).toBe(NotificationStatus.Scheduled);
  });

  it('sans dossier, il le dit et oriente — il n’échoue pas en silence', async () => {
    await repo.save(reminder());
    const harness = makeSlackHandler({
      directoryRepository: makeDirectoryDouble({ employeeId: null, realName: 'Sans dossier' }),
      notificationRepository: repo,
      now: () => NOW,
    });

    await harness.handler.handleMessage(dm('annule le rappel'));

    expect(harness.postedTexts().join('\n')).toContain('compléter mon profil');
    expect((await repo.findById('r-jeudi'))?.status).toBe(NotificationStatus.Scheduled);
  });
});

describe('le miroir du rationnement', () => {
  it('« annule le rappel » est GRATUIT — il ne doit pas être refusé au quota', () => {
    // Quatrième occurrence de ce défaut si on l'oubliait : après « bonjour » (2026-08-13),
    // `profile_done` (2026-08-19) et le « oui » d'un email en attente (2026-08-20).
    expect(isAnsweredWithoutModel({ text: 'annule le rappel de jeudi' })).toBe(true);
  });
});
