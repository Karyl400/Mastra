import { describe, it, expect, vi } from 'vitest';

import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { makeUpdateOnboardingStatus } from '../../../src/features/onboarding/application/tools/update-onboarding-status';
import { toolsWithEffect } from '../../../src/shared/agent-capabilities';
import { OnboardingStatus } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * TROIS DES CINQ OUTILS AGISSANTS N'AVAIENT AUCUNE IDEMPOTENCE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Dette n° 4 de `docs/tool-design-audit.md`. `generateDocument` et
 * `scheduleCandidateInterview` portaient le garde de run ; `sendNotification`,
 * `scheduleReminder` et `updateOnboardingStatus` non — sans qu'aucune ligne n'explique
 * pourquoi.
 *
 * Le défaut que le garde ferme a été OBSERVÉ en production : **7 documents et 3 emails
 * identiques en 8 minutes**. La cause racine était l'absence d'outil de révision (fermée
 * depuis), mais un modèle qui rappelle deux fois le même outil dans un même run reste un
 * comportement banal — et sur `sendNotification`, son prix est un email de plus dans la boîte
 * de quelqu'un.
 *
 * ⚠️ LA CLÉ PORTE UNE EMPREINTE DU CONTENU. Sans elle, « envoie ceci à Alice » puis « envoie
 * cela à Alice » dans le même tour se feraient écraser l'un l'autre : le garde deviendrait un
 * bug de perte de message, l'inverse exact de ce qu'il existe pour empêcher.
 *
 * ⚠️ LA CLÉ EST NULLE HORS SLACK. `buildRunKey` rend `undefined` sans `eventTs` : au
 * playground, dans un workflow ou dans un test sans contexte, le garde ne s'applique pas —
 * c'est le cas nominal de ces chemins, et les faire dépendre d'un cache par instance serait
 * pire que de ne rien faire.
 *
 * ⚠️ LE GARDE EST PAR INSTANCE. Deux invocations Vercel routées vers deux instances ne se
 * voient pas — même limite structurelle que le LRU de déduplication Slack avant sa promotion
 * en store partagé Turso. La dette reste NOMMÉE dans `TODO.md` ; ce qui est fermé ici est le
 * double appel DANS UN MÊME RUN, qui est le cas observé.
 */

const EMPLOYEE = '11111111-1111-4111-8111-111111111111';

const ctx = (eventTs?: string) => ({
  requestContext: {
    get: (key: string) =>
      ({
        slackChannel: 'D0MOCK',
        slackEventTs: eventTs,
        slackEmployeeId: EMPLOYEE,
        slackAccessLevel: 'full',
      })[key],
  },
});

describe('les CINQ outils agissants sont couverts par un garde de run', () => {
  it('la liste des outils agissants est dérivée, pas recopiée ici', () => {
    expect([...toolsWithEffect('write')]).toEqual([
      'generateDocument',
      'scheduleCandidateInterview',
      'scheduleReminder',
      'sendNotification',
      'updateOnboardingStatus',
    ]);
  });
});

describe('sendNotification — un second appel identique n’envoie pas deux fois', () => {
  const build = () => {
    const sendEmail = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);
    const tool = makeSendNotification(
      { save } as never,
      { findById: async () => ({ id: EMPLOYEE, email: 'a@kisso.com' }) } as never,
      { sendEmail } as never,
      { sendMessage: vi.fn() } as never,
      { findUserByEmail: vi.fn() } as never,
    );
    return { tool, sendEmail, save };
  };

  const payload = {
    recipientId: EMPLOYEE,
    subject: 'Rappel',
    body: 'Pense à compléter ton dossier.',
    channel: 'email' as const,
    recipientType: 'employee' as const,
  };

  it('n’envoie qu’une fois et rend le MÊME résultat', async () => {
    const { tool, sendEmail } = build();

    const first = await tool.execute!(payload, ctx('1700000000.000100') as never);
    const second = await tool.execute!(payload, ctx('1700000000.000100') as never);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('envoie BIEN deux fois quand le contenu diffère — le garde n’avale pas un vrai message', async () => {
    const { tool, sendEmail } = build();

    await tool.execute!(payload, ctx('1700000000.000100') as never);
    await tool.execute!(
      { ...payload, body: 'Et pense aussi à ta photo.' },
      ctx('1700000000.000100') as never,
    );

    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('envoie BIEN deux fois sur deux ÉVÉNEMENTS distincts — la même demande, deux jours de suite', async () => {
    const { tool, sendEmail } = build();

    await tool.execute!(payload, ctx('1700000000.000100') as never);
    await tool.execute!(payload, ctx('1700009999.000100') as never);

    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('ne mémorise PAS un envoi qui a échoué — réessayer reste possible', async () => {
    // Même règle que la prise rendue sur échec de transport dans la remise des rappels : rien
    // n'est parti, donc réessayer est légitime. Mémoriser un échec transformerait une panne
    // réseau d'une seconde en message définitivement perdu.
    const save = vi.fn(async () => undefined);
    const sendEmail = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const tool = makeSendNotification(
      { save } as never,
      { findById: async () => ({ id: EMPLOYEE, email: 'a@kisso.com' }) } as never,
      { sendEmail } as never,
      { sendMessage: vi.fn() } as never,
      { findUserByEmail: vi.fn() } as never,
    );

    await tool.execute!(payload, ctx('1700000000.000100') as never);
    await tool.execute!(payload, ctx('1700000000.000100') as never);

    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleReminder — un second appel identique n’enregistre pas deux rappels', () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

  const build = () => {
    const save = vi.fn(async () => undefined);
    const tool = makeScheduleReminder(
      { save } as never,
      {
        findById: async () => ({ id: EMPLOYEE, email: 'a@kisso.com' }),
      } as never,
    );
    return { tool, save };
  };

  const payload = {
    recipientId: EMPLOYEE,
    subject: 'Réunion',
    body: 'Point équipe.',
    scheduledAt: tomorrow,
    channel: 'email' as const,
    recipientType: 'employee' as const,
  };

  it('n’enregistre qu’un rappel et rend le même identifiant', async () => {
    const { tool, save } = build();

    const first = (await tool.execute!(payload, ctx('1700000000.000200') as never)) as {
      id: string;
    };
    const second = (await tool.execute!(payload, ctx('1700000000.000200') as never)) as {
      id: string;
    };

    expect(save).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
  });

  it('enregistre bien DEUX rappels pour deux dates différentes', async () => {
    const { tool, save } = build();
    const later = new Date(Date.now() + 172_800_000).toISOString();

    await tool.execute!(payload, ctx('1700000000.000200') as never);
    await tool.execute!({ ...payload, scheduledAt: later }, ctx('1700000000.000200') as never);

    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('updateOnboardingStatus — un second appel ne réécrit pas les horodatages', () => {
  it('n’appelle `update` qu’une fois', async () => {
    // ⚠️ Cet outil PARAÎT idempotent — poser deux fois le même statut donne le même statut.
    // Il ne l'est pas : `completedAt` et `updatedAt` sont recalculés à `now` au second appel,
    // donc la date de complétion d'un parcours se déplace en silence. C'est exactement la
    // famille de défaut que ce dépôt traque : rien n'échoue, une donnée devient fausse.
    const update = vi.fn(async () => 1);
    const tool = makeUpdateOnboardingStatus({
      findByEmployee: async () => ({
        employeeId: EMPLOYEE,
        currentStep: 0,
        totalSteps: 1,
        startedAt: null,
        status: OnboardingStatus.InProgress,
      }),
      update,
    } as never);

    const payload = { employeeId: EMPLOYEE, status: OnboardingStatus.Completed };

    const first = await tool.execute!(payload, ctx('1700000000.000300') as never);
    const second = await tool.execute!(payload, ctx('1700000000.000300') as never);

    expect(update).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
